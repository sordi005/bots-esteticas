import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { JobHandler } from '../jobs/runner.js';
import type { MercadoPagoClient } from '../mercadopago/client.js';
import { loadMercadoPagoCredential } from '../mercadopago/connection.js';
import { applyApprovedPayment } from '../mercadopago/payment-processing.js';
import { deposits } from '../payments/schema.js';
import { expirePayloadSchema } from '../scheduling/appointment-jobs.js';
import { holdsSchedule } from '../scheduling/availability.js';
import { expireReservation } from '../scheduling/booking.js';
import { appointments } from '../scheduling/schema.js';
import { loadNoticeAppointment } from './notice-data.js';
import { enqueueNotification } from './outbox.js';
import { notifications } from './schema.js';
import { reservationExpired, reservationExpiredTemplate } from './texts.js';

/**
 * El vencimiento de la reserva provisoria (4.5, H10). Lo decide `booking.ts` con el turno bloqueado:
 * solo vence uno pendiente de seña con el plazo pasado, nunca uno en verificación. En la misma
 * transacción queda el aviso a la clienta, que ofrece otro horario. Si el turno ya estaba vencido (lo
 * venció una reserva que pisaba su horario) también avisa: el aviso sale una vez, venza por donde venza.
 *
 * Una seña de Mercado Pago, antes de vencer, se busca en Mercado Pago por su `external_reference`
 * (decisión 42): si el webhook se perdió y hay un pago aprobado, se procesa en vez de vencer el turno.
 */

export interface ExpiryDependencies {
  db: NodePgDatabase;
  logger: Logger;
  now: () => Date;
  /** Sin esto no se busca el pago antes de vencer: la aplicación de Mercado Pago no está configurada. */
  mercadoPago?: { client: MercadoPagoClient; credentialsKey: Buffer };
}

export type ExpiryJobResult =
  | 'expired'
  | 'already_expired'
  | 'not_due'
  | 'not_pending'
  | 'not_found'
  /** Tenía un pago aprobado de Mercado Pago que no había llegado por webhook: quedó confirmado. */
  | 'paid';

/** Busca en Mercado Pago el pago de una seña vencida y lo aplica. True si el turno quedó confirmado. */
async function confirmedByLostPayment(
  deps: ExpiryDependencies,
  input: { tenantId: string; appointmentId: string; now: Date },
): Promise<boolean> {
  const { db, mercadoPago } = deps;
  const { tenantId, appointmentId, now } = input;
  if (!mercadoPago) return false;

  const [deposit] = await db
    .select({ id: deposits.id, method: deposits.method, status: deposits.status, expiresAt: deposits.expiresAt })
    .from(deposits)
    .innerJoin(appointments, and(eq(appointments.tenantId, deposits.tenantId), eq(appointments.id, deposits.appointmentId)))
    .where(
      and(eq(deposits.tenantId, tenantId), eq(deposits.appointmentId, appointmentId), eq(appointments.status, 'PENDING_DEPOSIT')),
    );
  if (deposit?.method !== 'mercadopago' || deposit.status !== 'pending') return false;
  // La misma regla con la que vence (4.3): antes del plazo no hay nada que buscar.
  if (holdsSchedule({ status: 'PENDING_DEPOSIT', depositExpiresAt: deposit.expiresAt }, now)) return false;

  const credential = await loadMercadoPagoCredential(db, mercadoPago.credentialsKey, tenantId);
  if (!credential) return false;

  let payments;
  try {
    payments = await mercadoPago.client.searchPayments({ accessToken: credential.accessToken, externalReference: deposit.id });
  } catch (error) {
    // Vence igual: si el pago existe, su webhook entra después y lo trata como un pago tardío (4.5).
    deps.logger.warn({ err: error, tenant_id: tenantId, appointment_id: appointmentId }, 'No se pudo buscar el pago antes de vencer la seña');
    return false;
  }

  for (const payment of payments) {
    if (payment.status !== 'approved') continue;
    const result = await applyApprovedPayment(deps, { tenantId, payment, now });
    if (result === 'confirmed') {
      deps.logger.info({ tenant_id: tenantId, appointment_id: appointmentId }, 'Pago de Mercado Pago encontrado antes de vencer la seña');
      return true;
    }
  }
  return false;
}

export async function runReservationExpiry(
  deps: ExpiryDependencies,
  input: { tenantId: string; appointmentId: string },
): Promise<ExpiryJobResult> {
  const { db } = deps;
  const { tenantId, appointmentId } = input;
  const now = deps.now();

  if (await confirmedByLostPayment(deps, { tenantId, appointmentId, now })) return 'paid';

  const result = await expireReservation(db, {
    tenantId,
    appointmentId,
    now,
    inTransaction: async (tx, { start }) => {
      const [already] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            eq(notifications.appointmentId, appointmentId),
            eq(notifications.kind, 'reservation_expired'),
            eq(notifications.appointmentStart, start),
          ),
        );
      if (already) return;

      const appointment = await loadNoticeAppointment(tx, { tenantId, appointmentId });
      await enqueueNotification(tx, {
        tenantId,
        recipient: 'customer',
        kind: 'reservation_expired',
        customerId: appointment.customerId,
        appointmentId,
        appointmentStart: start,
        message: reservationExpired(appointment),
        template: reservationExpiredTemplate(appointment),
        now,
      });
    },
  });
  return result.ok ? result.outcome : result.reason;
}

/** El handler de las tareas `expire_reservation` para el worker. */
export function reservationExpiryJobHandler(deps: ExpiryDependencies): JobHandler {
  return async (job, { signal }) => {
    const payload = expirePayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new Error(`Datos de la tarea inválidos: ${z.prettifyError(payload.error)}`);
    }
    signal.throwIfAborted();
    const result = await runReservationExpiry(deps, { tenantId: job.tenantId, appointmentId: payload.data.appointmentId });
    deps.logger.info({ tenant_id: job.tenantId, appointment_id: payload.data.appointmentId, result }, 'Vencimiento de reserva');
  };
}
