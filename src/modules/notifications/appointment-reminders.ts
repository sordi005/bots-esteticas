import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { z } from 'zod';
import { businessInfo } from '../catalog/schema.js';
import type { JobHandler } from '../jobs/runner.js';
import { reminderPayloadSchema, type ReminderPayload } from '../scheduling/appointment-jobs.js';
import { receivesReminder } from '../scheduling/appointment-state-machine.js';
import { isWithinReminderWindow } from '../scheduling/reminders.js';
import { appointments } from '../scheduling/schema.js';
import { tenants, tenantSettings } from '../tenants/schema.js';
import { loadNoticeAppointment } from './notice-data.js';
import { enqueueNotification } from './outbox.js';
import { notifications } from './schema.js';
import { appointmentReminder, shortAppointmentReminder } from './texts.js';

/**
 * Los recordatorios del turno (4.7, H10). La tarea puede correr tarde o más de una vez: antes de
 * avisar verifica, con el turno bloqueado, que el recordatorio siga teniendo sentido (regla 7). Deja
 * el aviso para la clienta, con plantilla: lo envía `send_notification`.
 */

export interface ReminderDependencies {
  db: NodePgDatabase;
  logger: Logger;
  now: () => Date;
}

export type ReminderResult =
  | 'queued'
  /** Ya había salido el recordatorio para este turno e inicio. */
  | 'already_queued'
  /** El turno se movió: esta tarea era para el horario anterior. */
  | 'stale'
  /** El turno no está confirmado ni en verificación (4.7). */
  | 'not_reminded'
  | 'started'
  /** Corrió tarde, fuera del horario de envío del negocio. */
  | 'late'
  /** El negocio está pausado o dado de baja. */
  | 'inactive'
  /** El recordatorio corto se desactivó o ya no hay dirección cargada. */
  | 'disabled'
  | 'not_found';

const KINDS = { day_before: 'appointment_reminder', short: 'appointment_short_reminder' } as const;

export async function sendAppointmentReminder(
  deps: ReminderDependencies,
  input: { tenantId: string; payload: ReminderPayload },
): Promise<ReminderResult> {
  const { db } = deps;
  const { tenantId, payload } = input;
  const now = deps.now();
  const kind = KINDS[payload.reminder];

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: appointments.status,
        timeRange: appointments.timeRange,
        tenantStatus: tenants.status,
        timeZone: tenants.timezone,
        windowStart: tenantSettings.reminderWindowStart,
        windowEnd: tenantSettings.reminderWindowEnd,
        shortReminderEnabled: tenantSettings.shortReminderEnabled,
      })
      .from(appointments)
      .innerJoin(tenants, eq(tenants.id, appointments.tenantId))
      .innerJoin(tenantSettings, eq(tenantSettings.tenantId, appointments.tenantId))
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, payload.appointmentId)))
      .for('update', { of: appointments });
    if (!current) return 'not_found';

    const start = current.timeRange.start;
    if (start.toISOString() !== payload.appointmentStart) return 'stale';
    if (!receivesReminder(current.status)) return 'not_reminded';
    if (start.getTime() <= now.getTime()) return 'started';
    if (current.tenantStatus !== 'active') return 'inactive';
    const window = { start: current.windowStart, end: current.windowEnd };
    if (!isWithinReminderWindow({ now, timeZone: current.timeZone, window })) return 'late';

    // Bajo el bloqueo del turno, dos ejecuciones no pueden pasar las dos por acá (y la base lo impide igual).
    const [already] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.appointmentId, payload.appointmentId),
          eq(notifications.kind, kind),
          eq(notifications.appointmentStart, start),
        ),
      );
    if (already) return 'already_queued';

    const appointment = await loadNoticeAppointment(tx, { tenantId, appointmentId: payload.appointmentId });
    let message;
    if (payload.reminder === 'day_before') {
      message = appointmentReminder({ appointmentId: payload.appointmentId, appointment });
    } else {
      const [address] = await tx
        .select({ content: businessInfo.content })
        .from(businessInfo)
        .where(and(eq(businessInfo.tenantId, tenantId), eq(businessInfo.topic, 'address')));
      if (!current.shortReminderEnabled || !address) return 'disabled';
      message = shortAppointmentReminder({ appointment, address: address.content });
    }

    await enqueueNotification(tx, {
      tenantId,
      recipient: 'customer',
      kind,
      customerId: appointment.customerId,
      appointmentId: payload.appointmentId,
      appointmentStart: start,
      message,
      now,
    });
    return 'queued';
  });
}

/** El handler de las tareas `send_appointment_reminder` para el worker. */
export function reminderJobHandler(deps: ReminderDependencies): JobHandler {
  return async (job, { signal }) => {
    const payload = reminderPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new Error(`Datos de la tarea inválidos: ${z.prettifyError(payload.error)}`);
    }
    signal.throwIfAborted();
    const result = await sendAppointmentReminder(deps, { tenantId: job.tenantId, payload: payload.data });
    const log = { tenant_id: job.tenantId, appointment_id: payload.data.appointmentId, reminder: payload.data.reminder, result };
    if (result === 'late') {
      deps.logger.warn(log, 'Recordatorio atrasado, fuera del horario de envío: no se envió');
    } else {
      deps.logger.info(log, 'Recordatorio de turno');
    }
  };
}
