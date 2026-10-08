import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
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
import { agentOutcomes } from './agent/outcome.js';

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

/** Cómo terminó una respuesta del agente. La lista y su significado están en `agent/outcome.ts`. */
export const agentOutcome = pgEnum('agent_outcome', agentOutcomes);

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
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
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
    /** Cuándo lo procesó el worker (sección 6.7). Solo los entrantes; null = todavía no. */
    processedAt: instant('processed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'messages_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    index('messages_conversation_idx').on(t.tenantId, t.conversationId, t.occurredAt),
    // Lo que el worker busca en cada vuelta: los entrantes de una conversación sin procesar.
    index('messages_unprocessed_idx')
      .on(t.tenantId, t.conversationId)
      .where(sql`${t.direction} = 'inbound' and ${t.processedAt} is null`),
    check(
      'messages_received_have_whatsapp_id',
      sql`${t.direction} = 'outbound' or ${t.whatsappMessageId} is not null`,
    ),
    check('messages_cost_non_negative', sql`${t.estimatedCostUsd} >= 0`),
    check(
      'messages_processed_only_inbound',
      sql`${t.direction} = 'inbound' or ${t.processedAt} is null`,
    ),
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

/**
 * Una fila por respuesta del agente (7.2, 8.5): qué modelo, cuántos tokens, qué herramientas y
 * cuánto tardó. Sirve para costos, latencia y detectar abusos. Nunca guarda contenido: ni los
 * mensajes ni los argumentos ni los resultados de las herramientas (10.1). Es de solo inserción.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    conversationId: uuid('conversation_id').notNull(),
    /** Modelo de la última llamada. Null si no se llamó al modelo (límite por hora). */
    model: text('model'),
    llmCalls: integer('llm_calls').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    /** Solo los nombres, en el orden en que se ejecutaron. */
    toolCalls: text('tool_calls').array().notNull().default([]),
    latencyMs: integer('latency_ms').notNull().default(0),
    outcome: agentOutcome('outcome').notNull(),
    /** Cuándo se hizo la respuesta (tabla de solo inserción). */
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'agent_runs_conversation_fk',
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }),
    index('agent_runs_conversation_idx').on(t.tenantId, t.conversationId, t.createdAt),
    check(
      'agent_runs_usage_non_negative',
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.cacheReadTokens} >= 0 and ${t.cacheWriteTokens} >= 0`,
    ),
    check('agent_runs_calls_and_latency_non_negative', sql`${t.llmCalls} >= 0 and ${t.latencyMs} >= 0`),
    check('agent_runs_model_matches_calls', sql`(${t.llmCalls} = 0) = (${t.model} is null)`),
  ],
);
