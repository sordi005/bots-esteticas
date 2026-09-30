import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, updatedAt } from '../../shared/db-columns.js';
import { appointments } from '../scheduling/schema.js';
import { tenantId } from '../tenants/schema.js';

export const paymentMethod = pgEnum('payment_method', ['mercadopago', 'transfer']);

export const depositStatus = pgEnum('deposit_status', [
  'pending',
  'in_review',
  'approved',
  'rejected',
  'expired',
]);

/**
 * Seña de un turno (sección 4.5). El dinero va directo a la cuenta del negocio.
 * Su id es el `external_reference` de la preferencia de Mercado Pago (sección 8.3).
 */
export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    appointmentId: uuid('appointment_id').notNull(),
    amountCents: integer('amount_cents').notNull(),
    /** Null hasta que la clienta elige cómo pagar. */
    method: paymentMethod('method'),
    status: depositStatus('status').notNull().default('pending'),
    /** Vencimiento de la reserva provisoria. */
    expiresAt: instant('expires_at').notNull(),
    mercadopagoPreferenceId: text('mercadopago_preference_id'),
    /** Único: los webhooks de pago se procesan una sola vez (CLAUDE.md, regla 6). */
    mercadopagoPaymentId: text('mercadopago_payment_id').unique(),
    /** Id del medio de WhatsApp con la foto del comprobante de transferencia. */
    receiptMediaId: text('receipt_media_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('deposits_tenant_id_id_key').on(t.tenantId, t.id),
    unique('deposits_tenant_appointment_key').on(t.tenantId, t.appointmentId),
    foreignKey({
      name: 'deposits_appointment_fk',
      columns: [t.tenantId, t.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }),
    check('deposits_amount_positive', sql`${t.amountCents} > 0`),
    check(
      'deposits_review_has_receipt',
      sql`${t.status} <> 'in_review' or ${t.receiptMediaId} is not null`,
    ),
  ],
);
