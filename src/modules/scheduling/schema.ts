import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  halfOpenRangeCheck,
  instant,
  timestampRange,
  updatedAt,
} from '../../shared/db-columns.js';
import { priceType, professionals, services } from '../catalog/schema.js';
import { customers } from '../customers/schema.js';
import { tenantId } from '../tenants/schema.js';

/** Estados de un turno (sección 4.4). Las transiciones válidas se definen en H3. */
export const appointmentStatus = pgEnum('appointment_status', [
  'PENDING_DEPOSIT',
  'DEPOSIT_REVIEW',
  'CONFIRMED',
  'DEPOSIT_REJECTED',
  'EXPIRED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED_BY_CUSTOMER',
  'CANCELLED_BY_BUSINESS',
]);

/** Quién hace algo en el sistema: el asistente, la dueña, una tarea programada o el administrador. */
export const actor = pgEnum('actor', ['assistant', 'owner', 'system', 'admin']);

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    professionalId: uuid('professional_id').notNull(),
    /**
     * Tiempo en que la profesional está ocupada: [inicio, inicio + duración + margen).
     * La restricción que impide superponer turnos (H4) se aplica sobre este rango.
     * El turno que ve la clienta termina en inicio + duración.
     */
    timeRange: timestampRange('time_range').notNull(),
    // Copia al momento de reservar: si la dueña cambia el servicio después,
    // los turnos ya tomados no cambian (sección 7).
    durationMinutes: integer('duration_minutes').notNull(),
    bufferMinutes: integer('buffer_minutes').notNull(),
    priceCents: integer('price_cents').notNull(),
    cashPriceCents: integer('cash_price_cents'),
    priceType: priceType('price_type').notNull(),
    status: appointmentStatus('status').notNull(),
    /** Quién creó el turno. */
    origin: actor('origin').notNull(),
    calendarEventId: text('calendar_event_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('appointments_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'appointments_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'appointments_service_fk',
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }),
    foreignKey({
      name: 'appointments_professional_fk',
      columns: [t.tenantId, t.professionalId],
      foreignColumns: [professionals.tenantId, professionals.id],
    }),
    index('appointments_customer_idx').on(t.tenantId, t.customerId),
    index('appointments_professional_idx').on(t.tenantId, t.professionalId),
    index('appointments_status_idx').on(t.tenantId, t.status),
    halfOpenRangeCheck('appointments_time_range_valid', t.timeRange),
    check(
      'appointments_time_range_matches_duration',
      sql`upper(${t.timeRange}) - lower(${t.timeRange})
        = make_interval(mins => ${t.durationMinutes} + ${t.bufferMinutes})`,
    ),
    check('appointments_duration_positive', sql`${t.durationMinutes} > 0`),
    check('appointments_buffer_non_negative', sql`${t.bufferMinutes} >= 0`),
    check('appointments_price_non_negative', sql`${t.priceCents} >= 0`),
    check('appointments_cash_price_non_negative', sql`${t.cashPriceCents} >= 0`),
  ],
);

/** Auditoría de cada transición de estado (CLAUDE.md, regla 4). Solo se insertan filas. */
export const appointmentEvents = pgTable(
  'appointment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    appointmentId: uuid('appointment_id').notNull(),
    /** Null en el evento de creación del turno. */
    fromStatus: appointmentStatus('from_status'),
    toStatus: appointmentStatus('to_status').notNull(),
    actor: actor('actor').notNull(),
    reason: text('reason'),
    occurredAt: instant('occurred_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'appointment_events_appointment_fk',
      columns: [t.tenantId, t.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }),
    index('appointment_events_appointment_idx').on(t.tenantId, t.appointmentId, t.occurredAt),
    check('appointment_events_status_changes', sql`${t.fromStatus} is distinct from ${t.toStatus}`),
  ],
);
