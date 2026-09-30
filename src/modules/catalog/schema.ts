import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  halfOpenRangeCheck,
  timestampRange,
  updatedAt,
} from '../../shared/db-columns.js';
import { depositRequirement, tenantId } from '../tenants/schema.js';

/** Temas de la información del negocio que el asistente puede consultar (sección 6.4). */
export const businessInfoTopic = pgEnum('business_info_topic', [
  'address',
  'parking',
  'payment_methods',
  'promotions',
  'policies',
  'aftercare',
]);

/** `from`: el asistente dice "desde $X" y el precio final lo confirma la profesional (4.1). */
export const priceType = pgEnum('price_type', ['fixed', 'from']);

/**
 * `closed`: el rango queda bloqueado.
 * `special_hours`: ese día, el rango reemplaza al horario semanal.
 */
export const scheduleExceptionKind = pgEnum('schedule_exception_kind', ['closed', 'special_hours']);

export const businessInfo = pgTable(
  'business_info',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    topic: businessInfoTopic('topic').notNull(),
    content: text('content').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('business_info_tenant_topic_key').on(t.tenantId, t.topic),
    check('business_info_content_not_blank', sql`btrim(${t.content}) <> ''`),
  ],
);

export const professionals = pgTable(
  'professionals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    googleCalendarId: text('google_calendar_id'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('professionals_tenant_id_id_key').on(t.tenantId, t.id)],
);

/** Campos de la sección 4.1. Los precios van en centavos. */
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    /** Cómo lo pide la gente: "semi", "semipermanente". */
    aliases: text('aliases').array().notNull().default([]),
    category: text('category').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    /** Margen posterior de limpieza o preparación. */
    bufferMinutes: integer('buffer_minutes').notNull().default(0),
    priceCents: integer('price_cents').notNull(),
    /** Precio en efectivo o transferencia, si el negocio lo diferencia. */
    cashPriceCents: integer('cash_price_cents'),
    priceType: priceType('price_type').notNull().default('fixed'),
    // Seña: si es null, hereda la regla del negocio (tenant_settings).
    depositRequirement: depositRequirement('deposit_requirement'),
    depositPercentage: integer('deposit_percentage'),
    depositFixedAmountCents: integer('deposit_fixed_amount_cents'),
    /** Si es true, el asistente no agenda directo: deriva. */
    requiresConsultation: boolean('requires_consultation').notNull().default(false),
    /** Días hasta el próximo mantenimiento (fidelización, fase 2). */
    maintenanceIntervalDays: integer('maintenance_interval_days'),
    /** Si es false, el asistente no lo ofrece. */
    visible: boolean('visible').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('services_tenant_id_id_key').on(t.tenantId, t.id),
    unique('services_tenant_name_key').on(t.tenantId, t.name),
    check('services_duration_positive', sql`${t.durationMinutes} > 0`),
    check('services_buffer_non_negative', sql`${t.bufferMinutes} >= 0`),
    check('services_price_non_negative', sql`${t.priceCents} >= 0`),
    check('services_cash_price_non_negative', sql`${t.cashPriceCents} >= 0`),
    check(
      'services_deposit_single_amount',
      sql`num_nonnulls(${t.depositPercentage}, ${t.depositFixedAmountCents}) <= 1`,
    ),
    check('services_deposit_percentage_range', sql`${t.depositPercentage} between 1 and 100`),
    check('services_deposit_fixed_positive', sql`${t.depositFixedAmountCents} > 0`),
    check('services_maintenance_interval_positive', sql`${t.maintenanceIntervalDays} > 0`),
  ],
);

/** Qué profesional hace qué servicio, y si le lleva otro tiempo. */
export const professionalServices = pgTable(
  'professional_services',
  {
    tenantId: tenantId(),
    professionalId: uuid('professional_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    durationOverrideMinutes: integer('duration_override_minutes'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'professional_services_pkey', columns: [t.professionalId, t.serviceId] }),
    foreignKey({
      name: 'professional_services_professional_fk',
      columns: [t.tenantId, t.professionalId],
      foreignColumns: [professionals.tenantId, professionals.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'professional_services_service_fk',
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }).onDelete('cascade'),
    index('professional_services_service_idx').on(t.tenantId, t.serviceId),
    check(
      'professional_services_duration_override_positive',
      sql`${t.durationOverrideMinutes} > 0`,
    ),
  ],
);

/**
 * Horario semanal: hora local del negocio, no un instante.
 * Puede haber varios bloques por día (por ejemplo, 9 a 13 y 15 a 20).
 */
export const workingHours = pgTable(
  'working_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    professionalId: uuid('professional_id').notNull(),
    /** 1 = lunes … 7 = domingo (ISO 8601). */
    weekday: smallint('weekday').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'working_hours_professional_fk',
      columns: [t.tenantId, t.professionalId],
      foreignColumns: [professionals.tenantId, professionals.id],
    }).onDelete('cascade'),
    index('working_hours_professional_idx').on(t.tenantId, t.professionalId),
    check('working_hours_weekday_iso', sql`${t.weekday} between 1 and 7`),
    check('working_hours_start_before_end', sql`${t.startTime} < ${t.endTime}`),
  ],
);

/** Días cerrados, horarios especiales, vacaciones. Sin profesional = todo el negocio. */
export const scheduleExceptions = pgTable(
  'schedule_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    professionalId: uuid('professional_id'),
    timeRange: timestampRange('time_range').notNull(),
    kind: scheduleExceptionKind('kind').notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'schedule_exceptions_professional_fk',
      columns: [t.tenantId, t.professionalId],
      foreignColumns: [professionals.tenantId, professionals.id],
    }).onDelete('cascade'),
    index('schedule_exceptions_tenant_idx').on(t.tenantId, t.professionalId),
    halfOpenRangeCheck('schedule_exceptions_time_range_valid', t.timeRange),
  ],
);

/**
 * Feriados nacionales. Es la única tabla global además de `tenants`: es un dato del
 * país, no de un negocio. Cada negocio decide con `tenant_settings.works_on_holidays`.
 */
export const holidays = pgTable('holidays', {
  date: date('date', { mode: 'string' }).primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});
