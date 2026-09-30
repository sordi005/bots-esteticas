import { index, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant } from '../../shared/db-columns.js';
import { actor } from '../scheduling/schema.js';
import { tenantId } from '../tenants/schema.js';

export const auditAction = pgEnum('audit_action', ['create', 'update', 'delete']);

/**
 * Quién cambió qué configuración y cuándo (sección 7). Solo se insertan filas.
 * Nunca se guardan valores de credenciales: para esas, solo que cambiaron.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    actor: actor('actor').notNull(),
    /** Tabla afectada, por ejemplo "services". */
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    action: auditAction('action').notNull(),
    /** Campos cambiados: { campo: { before, after } }. */
    changes: jsonb('changes').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: instant('occurred_at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_tenant_idx').on(t.tenantId, t.occurredAt)],
);
