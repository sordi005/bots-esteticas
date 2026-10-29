import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { JobHandler } from '../jobs/runner.js';
import { loadNoticeAppointment } from '../notifications/notice-data.js';
import { enqueueNotification } from '../notifications/outbox.js';
import { customerDepositConfirmed, customerDepositConfirmedTemplate } from '../notifications/texts.js';
import { applyMercadoPagoPayment } from '../scheduling/booking.js';
import type { MercadoPagoClient, MercadoPagoPayment } from './client.js';
import { loadMercadoPagoCredential } from './connection.js';

/**
 * Procesar un pago de Mercado Pago (4.5, 8.3): la tarea que programa el webhook, con el id del pago
 * como clave. Consulta el pago a la API con el token del negocio (el aviso no se cree) y verifica que
 * la seña sea de ese negocio, el estado, el monto y la moneda. La seña aprobada de un turno pendiente
 * lo confirma y la clienta recibe el mismo texto que con la transferencia; la dueña no recibe aviso.
 */
export interface PaymentProcessingDependencies {
  db: NodePgDatabase;
  logger: Logger;
  client: MercadoPagoClient;
  credentialsKey: Buffer;
  now: () => Date;
}

export type PaymentProcessingResult =
  | 'confirmed'
  | 'already_processed'
  /** Rechazado o todavía no aprobado: la clienta puede volver a intentar con el mismo link. */
  | 'not_approved'
  /** La referencia no es una seña de este negocio. */
  | 'unknown_deposit'
  | 'not_connected'
  /** Aprobado, pero el turno ya no esperaba la seña o el monto no la cubre: el turno no cambia. */
  | 'not_applied';

const depositReference = z.uuid();

/** Aplica un pago ya consultado a la API. Lo usan el webhook y la búsqueda antes de vencer (D9). */
export async function applyApprovedPayment(
  deps: Pick<PaymentProcessingDependencies, 'db' | 'logger'>,
  input: { tenantId: string; payment: MercadoPagoPayment; now: Date },
): Promise<PaymentProcessingResult> {
  const { db } = deps;
  const { tenantId, payment, now } = input;
  if (payment.status !== 'approved') return 'not_approved';
  const depositId = depositReference.safeParse(payment.externalReference);
  if (!depositId.success) return 'unknown_deposit';

  const result = await applyMercadoPagoPayment(db, {
    tenantId,
    depositId: depositId.data,
    payment: { id: payment.id, amountCents: payment.amountCents, currency: payment.currency },
    now,
    inTransaction: async (tx, { appointmentId, customerId }) => {
      const appointment = await loadNoticeAppointment(tx, { tenantId, appointmentId });
      await enqueueNotification(tx, {
        tenantId,
        recipient: 'customer',
        kind: 'deposit_confirmed',
        customerId,
        appointmentId,
        depositId: depositId.data,
        message: customerDepositConfirmed(appointment),
        template: customerDepositConfirmedTemplate(appointment),
        now,
      });
    },
  });

  if (result.ok) return 'confirmed';
  switch (result.reason) {
    case 'not_found':
      return 'unknown_deposit';
    case 'already_processed':
      return 'already_processed';
    case 'not_pending':
    case 'amount_mismatch':
      deps.logger.warn(
        { tenant_id: tenantId, appointment_id: result.appointmentId, reason: result.reason, status: result.status },
        'Pago de Mercado Pago que no se pudo aplicar a la seña',
      );
      return 'not_applied';
  }
}

export async function processMercadoPagoPayment(
  deps: PaymentProcessingDependencies,
  input: { tenantId: string; paymentId: string },
): Promise<PaymentProcessingResult> {
  const credential = await loadMercadoPagoCredential(deps.db, deps.credentialsKey, input.tenantId);
  if (!credential) return 'not_connected';

  // Si Mercado Pago no responde, la tarea falla y la cola reintenta.
  const payment = await deps.client.getPayment({ accessToken: credential.accessToken, paymentId: input.paymentId });
  return applyApprovedPayment(deps, { tenantId: input.tenantId, payment, now: deps.now() });
}

/** El handler de las tareas `process_mercadopago_payment`: la clave es el id del pago. */
export function paymentJobHandler(deps: PaymentProcessingDependencies): JobHandler {
  return async (job, { signal }) => {
    signal.throwIfAborted();
    const result = await processMercadoPagoPayment(deps, { tenantId: job.tenantId, paymentId: job.key });
    deps.logger.info({ tenant_id: job.tenantId, payment_id: job.key, result }, 'Pago de Mercado Pago procesado');
  };
}
