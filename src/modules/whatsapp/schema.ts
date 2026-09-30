import { jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from '../../shared/db-columns.js';
import { tenantId } from '../tenants/schema.js';

export const templateCategory = pgEnum('template_category', [
  'utility',
  'marketing',
  'authentication',
]);

export const templateApprovalStatus = pgEnum('template_approval_status', [
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
]);

/**
 * Plantillas aprobadas por Meta en la cuenta de cada negocio (sección 8.1).
 * Las del número de avisos del servicio (sección 8.2) no son de ningún negocio:
 * se modelan en H9.
 */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    /** Nombre de la plantilla en Meta. */
    metaName: text('meta_name').notNull(),
    category: templateCategory('category').notNull(),
    language: text('language').notNull().default('es_AR'),
    approvalStatus: templateApprovalStatus('approval_status').notNull().default('pending'),
    /** Nombres de las variables, en orden: {{1}}, {{2}}… */
    variables: jsonb('variables').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('message_templates_tenant_name_language_key').on(t.tenantId, t.metaName, t.language),
  ],
);
