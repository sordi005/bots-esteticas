import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, instant, updatedAt } from '../../shared/db-columns.js';
import { customers } from '../customers/schema.js';
import { tenantId } from '../tenants/schema.js';

export const assistantStatus = pgEnum('assistant_status', ['active', 'paused']);

/** `echo`: mensaje que la dueña mandó desde su app (coexistencia, sección 8.1). */
export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound', 'echo']);

/**
 * Por qué el asistente derivó a una persona (sección 4.8).
 * `sensitive_topic` cubre salud, alergias, embarazo y contraindicaciones: el resumen
 * de la derivación nunca incluye el detalle (CLAUDE.md, regla 9).
 */
export const handoffReason = pgEnum('handoff_reason', [
  'customer_request',
  'complaint',
  'sensitive_topic',
  'unsupported_media',
  'requires_consultation',
  'off_catalog',
  'policy_exception',
  'not_understood',
]);

export const handoffStatus = pgEnum('handoff_status', ['open', 'resolved']);

/** Una conversación por clienta y negocio. */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    assistantStatus: assistantStatus('assistant_status').notNull().default('active'),
    /** Hasta cuándo sigue pausado. Null en pausa = hasta que se reanude a mano. */
    pausedUntil: instant('paused_until'),
    lastMessageAt: instant('last_message_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('conversations_tenant_id_id_key').on(t.tenantId, t.id),
    unique('conversations_tenant_customer_key').on(t.tenantId, t.customerId),
    foreignKey({
      name: 'conversations_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    check(
      'conversations_active_not_paused',
      sql`${t.assistantStatus} = 'paused' or ${t.pausedUntil} is null`,
    ),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    direction: messageDirection('direction').notNull(),
    /** Tipo de mensaje según la API de WhatsApp: text, interactive, image, audio… */
    type: text('type').notNull(),
    content: jsonb('content').notNull(),
    /**
     * Id del mensaje en WhatsApp. Único: Meta reintenta webhooks y cada mensaje se
     * guarda una sola vez (sección 6.5). Un saliente lo recibe recién al enviarse.
     */
    whatsappMessageId: text('whatsapp_message_id').unique(),
    /** Categoría de precio de Meta: service, utility, marketing… (sección 8.1). */
    pricingCategory: text('pricing_category'),
    estimatedCostUsd: numeric('estimated_cost_usd', { precision: 10, scale: 4 }),
    /** Cuándo se envió o recibió según WhatsApp. */
    occurredAt: instant('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'messages_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    index('messages_conversation_idx').on(t.tenantId, t.conversationId, t.occurredAt),
    check(
      'messages_received_have_whatsapp_id',
      sql`${t.direction} = 'outbound' or ${t.whatsappMessageId} is not null`,
    ),
    check('messages_cost_non_negative', sql`${t.estimatedCostUsd} >= 0`),
  ],
);

export const handoffs = pgTable(
  'handoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    reason: handoffReason('reason').notNull(),
    /** Resumen de una línea para la dueña. */
    summary: text('summary').notNull(),
    status: handoffStatus('status').notNull().default('open'),
    resolvedAt: instant('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'handoffs_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    index('handoffs_status_idx').on(t.tenantId, t.status),
    check(
      'handoffs_resolved_at_matches_status',
      sql`(${t.status} = 'resolved') = (${t.resolvedAt} is not null)`,
    ),
  ],
);
