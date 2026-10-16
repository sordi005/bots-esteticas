import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, updatedAt } from '../../shared/db-columns.js';
import { handoffs } from '../conversation/schema.js';
import { customers } from '../customers/schema.js';
import { deposits } from '../payments/schema.js';
import { appointments } from '../scheduling/schema.js';
import { tenantId } from '../tenants/schema.js';
import type { OutgoingMessage } from '../whatsapp/outgoing.js';

/** A quién va un aviso: la dueña del negocio (8.2) o una clienta (por el número del negocio). */
export const notificationRecipient = pgEnum('notification_recipient', ['owner', 'customer']);

/**
 * Qué avisa (4.5, 4.6, 4.8). A la dueña: un comprobante (también sus recordatorios), una
 * derivación, una cancelación o una reprogramación del asistente, y qué pasó con el botón que
 * tocó. A la clienta: la seña confirmada o rechazada.
 */
export const notificationKind = pgEnum('notification_kind', [
  'deposit_receipt',
  'handoff',
  'appointment_cancelled',
  'appointment_rescheduled',
  'owner_reply_ack',
  'deposit_confirmed',
  'deposit_rejected',
]);

export const notificationStatus = pgEnum('notification_status', ['pending', 'sent', 'failed']);

/** Qué botón de un aviso tocó la dueña. */
export const ownerReplyAction = pgEnum('owner_reply_action', [
  'deposit_received',
  'deposit_not_received',
  'handoff_attended',
]);

/**
 * Avisos fuera de la respuesta del asistente (6.7, H9). Se guardan en la misma transacción que el
 * cambio que los origina y los envía la tarea `send_notification` (outbox): un cambio y su aviso
 * no pueden quedar desparejos. El texto lo escribe el código, nunca el modelo.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    recipient: notificationRecipient('recipient').notNull(),
    kind: notificationKind('kind').notNull(),
    /** La clienta a la que va o de la que se trata. */
    customerId: uuid('customer_id').notNull(),
    appointmentId: uuid('appointment_id'),
    depositId: uuid('deposit_id'),
    handoffId: uuid('handoff_id'),
    /** El mensaje listo para enviar. Al de un comprobante el envío le suma la imagen. */
    message: jsonb('message').$type<OutgoingMessage>().notNull(),
    /** La imagen del comprobante en el número del negocio: se sube al número que envía (8.2). */
    receiptMediaId: text('receipt_media_id'),
    status: notificationStatus('status').notNull().default('pending'),
    /** Único: un aviso enviado se registra una sola vez. */
    whatsappMessageId: text('whatsapp_message_id').unique(),
    sentAt: instant('sent_at'),
    /** Por qué no se pudo enviar. Nunca incluye tokens ni el contenido del mensaje (10.1). */
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('notifications_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'notifications_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'notifications_appointment_fk',
      columns: [t.tenantId, t.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }),
    foreignKey({
      name: 'notifications_deposit_fk',
      columns: [t.tenantId, t.depositId],
      foreignColumns: [deposits.tenantId, deposits.id],
    }),
    foreignKey({
      name: 'notifications_handoff_fk',
      columns: [t.tenantId, t.handoffId],
      foreignColumns: [handoffs.tenantId, handoffs.id],
    }),
    // Los recordatorios de un comprobante se cuentan por seña.
    index('notifications_deposit_idx').on(t.tenantId, t.depositId, t.kind),
    check(
      'notifications_sent_has_message_id',
      sql`(${t.status} = 'sent') = (${t.sentAt} is not null)
        and (${t.status} = 'sent') = (${t.whatsappMessageId} is not null)`,
    ),
    check(
      'notifications_receipt_has_deposit',
      sql`${t.kind} <> 'deposit_receipt' or (${t.depositId} is not null and ${t.receiptMediaId} is not null)`,
    ),
    check('notifications_handoff_has_handoff', sql`${t.kind} <> 'handoff' or ${t.handoffId} is not null`),
    check(
      'notifications_recipient_matches_kind',
      sql`(${t.recipient} = 'customer') = (${t.kind} in ('deposit_confirmed', 'deposit_rejected'))`,
    ),
  ],
);

/**
 * Los botones que toca la dueña en los avisos (4.5, 4.8). El webhook los guarda una sola vez
 * (Meta reintenta) y los procesa la tarea `process_owner_reply` (regla 6).
 */
export const ownerReplies = pgTable(
  'owner_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    notificationId: uuid('notification_id').notNull(),
    action: ownerReplyAction('action').notNull(),
    whatsappMessageId: text('whatsapp_message_id').notNull().unique(),
    /** Cuándo lo tocó, según WhatsApp. */
    receivedAt: instant('received_at').notNull(),
    /** Cuándo se procesó. Null = todavía no. */
    processedAt: instant('processed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'owner_replies_notification_fk',
      columns: [t.tenantId, t.notificationId],
      foreignColumns: [notifications.tenantId, notifications.id],
    }),
  ],
);
