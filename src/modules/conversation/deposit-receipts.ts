import { randomUUID } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Queryable } from '../../shared/db.js';
import { scheduleJob } from '../jobs/queue.js';
import type { JobHandler } from '../jobs/runner.js';
import { loadNoticeAppointment } from '../notifications/notice-data.js';
import { enqueueNotification } from '../notifications/outbox.js';
import { notifications } from '../notifications/schema.js';
import { depositReceiptNotice } from '../notifications/texts.js';
import { deposits } from '../payments/schema.js';
import { submitTransferReceipt } from '../scheduling/booking.js';
import { appointments } from '../scheduling/schema.js';
import { loadHumanAttention } from './handoff.js';

/**
 * El comprobante de una transferencia (4.5, 5.3). Qué imagen es un comprobante lo decide el
 * código, antes de llamar al modelo: así una foto nunca queda sin registrar porque el modelo no
 * llamó a algo. Si la dueña no contesta, se le vuelve a avisar.
 */

/** [S] Si la dueña no contesta, se le vuelve a avisar a las 2 horas (4.5). */
export const DEPOSIT_REMINDER_DELAY_MS = 2 * 60 * 60 * 1_000;
/** [S] Hasta 3 recordatorios (4.5). */
export const MAX_DEPOSIT_REMINDERS = 3;

export type ReceiptRegistration =
  | { kind: 'registered'; appointmentId: string; alreadyRegistered: boolean }
  /** No hay una seña por transferencia esperando comprobante: es una imagen como cualquier otra. */
  | { kind: 'not_receipt' }
  /** Varias señas esperan comprobante: el código no adivina cuál (4.5, deriva). */
  | { kind: 'several_pending' };

/**
 * Cuándo sale el próximo recordatorio: a las 2 horas, o al próximo inicio del horario de atención
 * si a esa hora no atiende nadie. Sin horario cargado, a las 2 horas.
 */
async function nextReminderAt(db: Queryable, input: { tenantId: string; now: Date }): Promise<Date> {
  const candidate = new Date(input.now.getTime() + DEPOSIT_REMINDER_DELAY_MS);
  const { attention } = await loadHumanAttention(db, { tenantId: input.tenantId, now: candidate });
  return attention.kind === 'later' ? attention.startsAt : candidate;
}

/** El aviso del comprobante a la dueña, con la imagen y los botones (4.5). `reminder`: 0 el primero. */
async function enqueueReceiptNotice(
  tx: Queryable,
  input: { tenantId: string; appointmentId: string; depositId: string; mediaId: string; reminder: number; now: Date },
): Promise<void> {
  const { tenantId, appointmentId, depositId, now } = input;
  const appointment = await loadNoticeAppointment(tx, { tenantId, appointmentId });
  const [deposit] = await tx
    .select({ amountCents: deposits.amountCents })
    .from(deposits)
    .where(and(eq(deposits.tenantId, tenantId), eq(deposits.id, depositId)));
  if (!deposit) throw new Error('No se encontró la seña del comprobante');

  const notificationId = randomUUID();
  await enqueueNotification(tx, {
    id: notificationId,
    tenantId,
    recipient: 'owner',
    kind: 'deposit_receipt',
    customerId: appointment.customerId,
    appointmentId,
    depositId,
    receiptMediaId: input.mediaId,
    message: depositReceiptNotice({ notificationId, appointment, amountCents: deposit.amountCents, reminder: input.reminder }),
    now,
  });
}

async function scheduleReminder(tx: Queryable, input: { tenantId: string; depositId: string; runAt: Date }) {
  await scheduleJob(tx, {
    tenantId: input.tenantId,
    kind: 'remind_deposit_receipt',
    key: input.depositId,
    payload: { depositId: input.depositId },
    runAt: input.runAt,
  });
}

/**
 * ¿La imagen que mandó la clienta es el comprobante? Lo es si tiene **una sola** seña por
 * transferencia pendiente y su turno sigue pendiente de seña (cancelar no cambia la seña, por eso
 * se mira el turno). Si lo es, el turno pasa a verificación y en la misma transacción se guarda el
 * aviso a la dueña y se programa el recordatorio. La misma imagen otra vez no vuelve a avisar.
 */
export async function registerTransferReceipt(
  db: NodePgDatabase,
  input: { tenantId: string; customerId: string; mediaId: string; now: Date },
): Promise<ReceiptRegistration> {
  const { tenantId, customerId, mediaId, now } = input;
  const ofThisCustomer = and(
    eq(deposits.tenantId, tenantId),
    eq(appointments.customerId, customerId),
  );
  const joinAppointment = and(eq(appointments.tenantId, deposits.tenantId), eq(appointments.id, deposits.appointmentId));

  // Un reintento de la vuelta trae la misma imagen: ya está registrada.
  const [registered] = await db
    .select({ appointmentId: appointments.id })
    .from(deposits)
    .innerJoin(appointments, joinAppointment)
    .where(and(ofThisCustomer, eq(deposits.receiptMediaId, mediaId)));
  if (registered) return { kind: 'registered', appointmentId: registered.appointmentId, alreadyRegistered: true };

  const pending = await db
    .select({ depositId: deposits.id })
    .from(deposits)
    .innerJoin(appointments, joinAppointment)
    .where(
      and(
        ofThisCustomer,
        eq(deposits.method, 'transfer'),
        eq(deposits.status, 'pending'),
        isNull(deposits.receiptMediaId),
        eq(appointments.status, 'PENDING_DEPOSIT'),
      ),
    );
  const [only] = pending;
  if (!only) return { kind: 'not_receipt' };
  if (pending.length > 1) return { kind: 'several_pending' };

  const reminderAt = await nextReminderAt(db, { tenantId, now });
  const result = await submitTransferReceipt(db, {
    tenantId,
    depositId: only.depositId,
    mediaId,
    now,
    inTransaction: async (tx, { appointmentId }) => {
      await enqueueReceiptNotice(tx, { tenantId, appointmentId, depositId: only.depositId, mediaId, reminder: 0, now });
      await scheduleReminder(tx, { tenantId, depositId: only.depositId, runAt: reminderAt });
    },
  });
  // Entre la búsqueda y el bloqueo el turno pudo dejar de esperar la seña (por ejemplo, venció).
  if (!result.ok) return { kind: 'not_receipt' };
  return { kind: 'registered', appointmentId: result.appointmentId, alreadyRegistered: result.alreadyRegistered };
}

export interface DepositReminderDependencies {
  db: NodePgDatabase;
  logger: Logger;
  now: () => Date;
}

export type DepositReminderResult = 'reminded' | 'deferred' | 'exhausted' | 'not_needed';

/**
 * La dueña no contestó el comprobante (4.5): se le vuelve a avisar, hasta 3 veces, solo dentro del
 * horario de atención. La tarea puede correr más de una vez: antes de avisar verifica, con la seña
 * bloqueada, que siga en verificación (regla 7).
 */
export async function remindDepositReceipt(
  deps: DepositReminderDependencies,
  input: { tenantId: string; depositId: string },
): Promise<DepositReminderResult> {
  const { db } = deps;
  const { tenantId, depositId } = input;
  const now = deps.now();

  const { attention } = await loadHumanAttention(db, { tenantId, now });
  const nextAt = await nextReminderAt(db, { tenantId, now });

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        appointmentId: appointments.id,
        appointmentStatus: appointments.status,
        depositStatus: deposits.status,
        receiptMediaId: deposits.receiptMediaId,
      })
      .from(deposits)
      .innerJoin(
        appointments,
        and(eq(appointments.tenantId, deposits.tenantId), eq(appointments.id, deposits.appointmentId)),
      )
      .where(and(eq(deposits.tenantId, tenantId), eq(deposits.id, depositId)))
      .for('update', { of: deposits });
    if (
      !current?.receiptMediaId ||
      current.depositStatus !== 'in_review' ||
      current.appointmentStatus !== 'DEPOSIT_REVIEW'
    ) {
      return 'not_needed' as const;
    }

    const [sent] = await tx
      .select({ total: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, tenantId),
          eq(notifications.depositId, depositId),
          eq(notifications.kind, 'deposit_receipt'),
        ),
      );
    const reminders = (sent?.total ?? 1) - 1;
    if (reminders >= MAX_DEPOSIT_REMINDERS) return 'exhausted' as const;

    if (attention.kind === 'later') {
      await scheduleReminder(tx, { tenantId, depositId, runAt: attention.startsAt });
      return 'deferred' as const;
    }

    await enqueueReceiptNotice(tx, {
      tenantId,
      appointmentId: current.appointmentId,
      depositId,
      mediaId: current.receiptMediaId,
      reminder: reminders + 1,
      now,
    });
    if (reminders + 1 < MAX_DEPOSIT_REMINDERS) {
      await scheduleReminder(tx, { tenantId, depositId, runAt: nextAt });
    }
    return 'reminded' as const;
  });
}

const remindPayload = z.object({ depositId: z.uuid() });

/** El handler de las tareas `remind_deposit_receipt` para el worker. */
export function depositReminderJobHandler(deps: DepositReminderDependencies): JobHandler {
  return async (job, { signal }) => {
    const payload = remindPayload.safeParse(job.payload);
    if (!payload.success) {
      throw new Error(`Datos de la tarea inválidos: ${z.prettifyError(payload.error)}`);
    }
    signal.throwIfAborted();
    const result = await remindDepositReceipt(deps, { tenantId: job.tenantId, depositId: payload.data.depositId });
    deps.logger.info({ tenant_id: job.tenantId, deposit_id: payload.data.depositId, result }, 'Recordatorio de comprobante');
  };
}
