import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, e164Check, instant, updatedAt } from '../../shared/db-columns.js';
import { professionals } from '../catalog/schema.js';
import { tenantId } from '../tenants/schema.js';

/**
 * Ficha de la clienta (sección 4.9). Se identifica por su número dentro de cada negocio:
 * la misma persona en dos negocios son dos registros distintos.
 *
 * No se guardan datos de salud, DNI ni datos bancarios (CLAUDE.md, regla 9).
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    phone: text('phone').notNull(),
    /** Nombre de perfil de WhatsApp: saludo provisorio. */
    whatsappProfileName: text('whatsapp_profile_name'),
    /** Nombre para el turno: lo pide el asistente la primera vez. */
    name: text('name'),
    preferredProfessionalId: uuid('preferred_professional_id'),
    noShowCount: integer('no_show_count').notNull().default(0),
    /** Consentimiento explícito para mensajes de marketing (fase 2). Null = no dio. */
    marketingConsentAt: instant('marketing_consent_at'),
    /** De dónde llegó: Instagram, recomendación, etc. */
    origin: text('origin'),
    /** Solo la dueña o el administrador, a mano. */
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('customers_tenant_id_id_key').on(t.tenantId, t.id),
    unique('customers_tenant_phone_key').on(t.tenantId, t.phone),
    foreignKey({
      name: 'customers_preferred_professional_fk',
      columns: [t.tenantId, t.preferredProfessionalId],
      foreignColumns: [professionals.tenantId, professionals.id],
    }),
    e164Check('customers_phone_e164', t.phone),
    check('customers_no_show_count_non_negative', sql`${t.noShowCount} >= 0`),
  ],
);
