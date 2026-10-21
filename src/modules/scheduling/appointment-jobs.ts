import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../../shared/db.js';
import { businessInfo } from '../catalog/schema.js';
import { scheduleJob } from '../jobs/queue.js';
import type { tenantSettings } from '../tenants/schema.js';
import { dayBeforeReminderAt, shortReminderAt } from './reminders.js';

/**
 * Las tareas que deja programadas un turno (4.5, 4.7, H10), siempre en la misma transacción que la
 * reserva o la reprogramación: ninguna forma de reservar se las olvida. Una fila por turno y tipo
 * (6.7): reprogramar mueve la misma fila.
 */

export const reminderPayloadSchema = z.object({
  appointmentId: z.uuid(),
  reminder: z.enum(['day_before', 'short']),
  /** El inicio para el que se calculó: si el turno se movió, la tarea ya no envía nada (4.7). */
  appointmentStart: z.iso.datetime(),
});

export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;

export const expirePayloadSchema = z.object({ appointmentId: z.uuid() });

const REMINDER_KEY_SUFFIX = { day_before: 'dia_anterior', short: 'corto' } as const;

type Settings = Pick<
  typeof tenantSettings.$inferSelect,
  'reminderWindowStart' | 'reminderWindowEnd' | 'shortReminderEnabled'
>;

async function hasAddress(tx: Queryable, tenantId: string): Promise<boolean> {
  const [address] = await tx
    .select({ id: businessInfo.id })
    .from(businessInfo)
    .where(and(eq(businessInfo.tenantId, tenantId), eq(businessInfo.topic, 'address')));
  return Boolean(address);
}

/**
 * Programa los recordatorios de un turno con el horario `start`, reservado (o reprogramado) en
 * `bookedAt`. El corto, solo si el negocio lo activó y tiene la dirección cargada. Un recordatorio
 * que ya no corresponde no se borra: su tarea guarda el inicio anterior y no envía nada.
 */
export async function scheduleReminders(
  tx: Queryable,
  input: { tenantId: string; appointmentId: string; start: Date; bookedAt: Date; timeZone: string; settings: Settings },
): Promise<void> {
  const { tenantId, appointmentId, start, settings } = input;
  const timing = {
    appointmentStart: start,
    bookedAt: input.bookedAt,
    timeZone: input.timeZone,
    window: { start: settings.reminderWindowStart, end: settings.reminderWindowEnd },
  };

  const reminders: [ReminderPayload['reminder'], Date | null][] = [['day_before', dayBeforeReminderAt(timing)]];
  if (settings.shortReminderEnabled && (await hasAddress(tx, tenantId))) {
    reminders.push(['short', shortReminderAt(timing)]);
  }

  for (const [reminder, runAt] of reminders) {
    if (!runAt) continue;
    const payload: ReminderPayload = { appointmentId, reminder, appointmentStart: start.toISOString() };
    await scheduleJob(tx, {
      tenantId,
      kind: 'send_appointment_reminder',
      key: `${appointmentId}:${REMINDER_KEY_SUFFIX[reminder]}`,
      payload,
      runAt,
    });
  }
}

/** La reserva provisoria vence con su seña (4.5): la tarea la vence si todavía no se pagó. */
export async function scheduleReservationExpiry(
  tx: Queryable,
  input: { tenantId: string; appointmentId: string; expiresAt: Date },
): Promise<void> {
  await scheduleJob(tx, {
    tenantId: input.tenantId,
    kind: 'expire_reservation',
    key: input.appointmentId,
    payload: { appointmentId: input.appointmentId },
    runAt: input.expiresAt,
  });
}
