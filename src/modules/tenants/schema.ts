import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, e164Check, instant, updatedAt } from '../../shared/db-columns.js';

export const tenantStatus = pgEnum('tenant_status', ['active', 'paused', 'cancelled']);

/** Paquetes comerciales (sección 3.2): Básico, Turnos, Completo. */
export const tenantPlan = pgEnum('tenant_plan', ['basic', 'appointments', 'complete']);

export const emojiUsage = pgEnum('emoji_usage', ['none', 'low', 'medium']);

/** ¿A quién se le pide seña? (sección 4.5). */
export const depositRequirement = pgEnum('deposit_requirement', [
  'never',
  'always',
  'new_customers',
  'customers_with_no_shows',
]);

export const depositPaymentOptions = pgEnum('deposit_payment_options', [
  'mercadopago',
  'transfer',
  'both',
]);

export const credentialKind = pgEnum('credential_kind', ['whatsapp', 'mercadopago', 'google']);

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    /** Zona IANA. Se usa solo para mostrar: en la base todo es UTC. */
    timezone: text('timezone').notNull().default('America/Argentina/Mendoza'),
    status: tenantStatus('status').notNull().default('active'),
    plan: tenantPlan('plan').notNull(),
    // Tono del asistente (sección 5.1, principio 6)
    assistantName: text('assistant_name').notNull(),
    emojiUsage: emojiUsage('emoji_usage').notNull().default('low'),
    usesVoseo: boolean('uses_voseo').notNull().default(true),
    /** Identifica al negocio en los webhooks de WhatsApp (sección 6.5). */
    whatsappPhoneNumberId: text('whatsapp_phone_number_id').unique(),
    /** A dónde le llegan los avisos a la dueña (sección 8.2). */
    ownerPhone: text('owner_phone'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('tenants_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    e164Check('tenants_owner_phone_e164', t.ownerPhone),
  ],
);

/**
 * Columna `tenant_id` de toda tabla de negocio (CLAUDE.md, regla 1).
 * Las tablas hijas además usan claves foráneas compuestas (tenant_id, id_padre):
 * así la base impide mezclar datos de dos negocios aunque el código tenga un bug.
 */
export const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);

/** Bloque del horario de atención humana. `weekday`: 1 = lunes … 7 = domingo (ISO 8601). */
export interface AttentionHoursBlock {
  weekday: number;
  /** "HH:MM", hora local del negocio. */
  start: string;
  end: string;
}

export const tenantSettings = pgTable(
  'tenant_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),

    // Señas (sección 4.5). El monto es un porcentaje o un monto fijo, nunca los dos.
    depositRequirement: depositRequirement('deposit_requirement').notNull().default('always'),
    depositPercentage: integer('deposit_percentage').default(30),
    depositFixedAmountCents: integer('deposit_fixed_amount_cents'),
    depositPaymentWindowMinutes: integer('deposit_payment_window_minutes').notNull().default(60),
    depositPaymentOptions: depositPaymentOptions('deposit_payment_options').notNull().default('both'),
    transferAlias: text('transfer_alias'),
    transferCbu: text('transfer_cbu'),
    transferAccountHolder: text('transfer_account_holder'),

    // Cancelación y reprogramación (secciones 4.5 y 4.6)
    freeCancellationNoticeHours: integer('free_cancellation_notice_hours').notNull().default(24),
    reschedulesKeepingDeposit: integer('reschedules_keeping_deposit').notNull().default(1),

    // Disponibilidad (sección 4.3)
    slotGranularityMinutes: integer('slot_granularity_minutes').notNull().default(15),
    minBookingNoticeMinutes: integer('min_booking_notice_minutes').notNull().default(120),
    maxBookingAdvanceDays: integer('max_booking_advance_days').notNull().default(30),
    slotsOffered: integer('slots_offered').notNull().default(3),
    worksOnHolidays: boolean('works_on_holidays').notNull().default(false),

    // Derivaciones: cuándo puede responder una persona (sección 4.8)
    humanAttentionHours: jsonb('human_attention_hours')
      .$type<AttentionHoursBlock[]>()
      .notNull()
      .default([]),

    // Recordatorios (sección 4.7), hora local del negocio
    reminderWindowStart: time('reminder_window_start').notNull().default('09:00'),
    reminderWindowEnd: time('reminder_window_end').notNull().default('21:00'),
    shortReminderEnabled: boolean('short_reminder_enabled').notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'tenant_settings_deposit_single_amount',
      sql`num_nonnulls(${t.depositPercentage}, ${t.depositFixedAmountCents}) = 1`,
    ),
    check('tenant_settings_deposit_percentage_range', sql`${t.depositPercentage} between 1 and 100`),
    check('tenant_settings_deposit_fixed_positive', sql`${t.depositFixedAmountCents} > 0`),
    check('tenant_settings_payment_window_positive', sql`${t.depositPaymentWindowMinutes} > 0`),
    check('tenant_settings_transfer_cbu_format', sql`${t.transferCbu} ~ '^[0-9]{22}$'`),
    check('tenant_settings_cancellation_notice', sql`${t.freeCancellationNoticeHours} >= 0`),
    check('tenant_settings_reschedules', sql`${t.reschedulesKeepingDeposit} >= 0`),
    check('tenant_settings_slot_granularity', sql`${t.slotGranularityMinutes} between 5 and 60`),
    check('tenant_settings_min_booking_notice', sql`${t.minBookingNoticeMinutes} >= 0`),
    check('tenant_settings_max_booking_advance', sql`${t.maxBookingAdvanceDays} > 0`),
    check('tenant_settings_slots_offered', sql`${t.slotsOffered} between 1 and 10`),
    check(
      'tenant_settings_reminder_window',
      sql`${t.reminderWindowStart} < ${t.reminderWindowEnd}`,
    ),
  ],
);

/**
 * Credenciales de terceros cifradas con AES-256-GCM (sección 9.1).
 * Nunca se guardan en claro ni se loguean.
 */
export const tenantCredentials = pgTable(
  'tenant_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kind: credentialKind('kind').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    iv: bytea('iv').notNull(),
    authTag: bytea('auth_tag').notNull(),
    expiresAt: instant('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('tenant_credentials_tenant_kind_key').on(t.tenantId, t.kind),
    check('tenant_credentials_iv_length', sql`octet_length(${t.iv}) = 12`),
    check('tenant_credentials_auth_tag_length', sql`octet_length(${t.authTag}) = 16`),
  ],
);
