import { and, asc, between, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  holidays,
  professionals,
  professionalServices,
  scheduleExceptions,
  services,
  workingHours,
} from '../catalog/schema.js';
import { deposits } from '../payments/schema.js';
import { tenants, tenantSettings } from '../tenants/schema.js';
import type { Queryable } from '../../shared/db.js';
import { formatTimestampRange, type TimestampRange } from '../../shared/timestamp-range.js';
import { instantToLocal } from '../../shared/time-zone.js';
import { occupiesSchedule, APPOINTMENT_STATUSES } from './appointment-state-machine.js';
import {
  occupiedRanges,
  type AvailabilityQuery,
  type ProfessionalSchedule,
} from './availability.js';
import { appointments } from './schema.js';

/**
 * Lee de la base todo lo que necesita el cálculo de disponibilidad (función pura) para un
 * servicio de un negocio. Toda consulta filtra por `tenant_id` (CLAUDE.md, regla 1).
 */
export interface AvailabilityContext {
  query: AvailabilityQuery;
  service: typeof services.$inferSelect;
  settings: typeof tenantSettings.$inferSelect;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const OCCUPYING_STATUSES = APPOINTMENT_STATUSES.filter(occupiesSchedule);

/** `columna && rango`: el rango de la columna se superpone con `range`. */
export function overlaps(column: AnyPgColumn, range: TimestampRange): SQL {
  return sql`${column} && ${formatTimestampRange(range)}::tstzrange`;
}

export async function loadAvailabilityContext(
  db: Queryable,
  input: {
    tenantId: string;
    serviceId: string;
    window: TimestampRange;
    now: Date;
    /** Limita la búsqueda a estas profesionales. Sin esto, todas las que hacen el servicio. */
    professionalIds?: string[];
    /** Un turno que no cuenta como ocupado: el que se está reprogramando. */
    excludeAppointmentId?: string;
    /** Eventos ocupados de Google Calendar por profesional (H12). */
    calendarBusy?: ReadonlyMap<string, TimestampRange[]>;
  },
): Promise<AvailabilityContext | null> {
  const { tenantId, serviceId, window, now } = input;

  const [business] = await db
    .select({ timezone: tenants.timezone, settings: tenantSettings })
    .from(tenants)
    .innerJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id))
    .where(eq(tenants.id, tenantId));
  const [service] = await db
    .select()
    .from(services)
    .where(and(eq(services.tenantId, tenantId), eq(services.id, serviceId)));
  if (!business || !service) return null;

  const team = await db
    .select({
      id: professionals.id,
      durationOverrideMinutes: professionalServices.durationOverrideMinutes,
    })
    .from(professionalServices)
    .innerJoin(
      professionals,
      and(
        eq(professionals.tenantId, professionalServices.tenantId),
        eq(professionals.id, professionalServices.professionalId),
      ),
    )
    .where(
      and(
        eq(professionalServices.tenantId, tenantId),
        eq(professionalServices.serviceId, serviceId),
        eq(professionals.active, true),
        input.professionalIds ? inArray(professionals.id, input.professionalIds) : undefined,
      ),
    )
    // Orden fijo para asignar "la primera disponible" (sección 4.2).
    .orderBy(asc(professionals.name), asc(professionals.id));

  // Un turno o un cierre de antes o después de la ventana igual puede pisar sus bordes.
  const around: TimestampRange = {
    start: new Date(window.start.getTime() - DAY_MS),
    end: new Date(window.end.getTime() + DAY_MS),
  };
  const teamIds = team.map((professional) => professional.id);

  const [hours, exceptions, holidayRows, booked] =
    teamIds.length === 0
      ? [[], [], [], []]
      : await Promise.all([
          db
            .select()
            .from(workingHours)
            .where(and(eq(workingHours.tenantId, tenantId), inArray(workingHours.professionalId, teamIds))),
          db
            .select()
            .from(scheduleExceptions)
            .where(
              and(
                eq(scheduleExceptions.tenantId, tenantId),
                or(
                  isNull(scheduleExceptions.professionalId),
                  inArray(scheduleExceptions.professionalId, teamIds),
                ),
                overlaps(scheduleExceptions.timeRange, around),
              ),
            ),
          db
            .select({ date: holidays.date })
            .from(holidays)
            .where(
              between(
                holidays.date,
                instantToLocal(around.start, business.timezone).date,
                instantToLocal(around.end, business.timezone).date,
              ),
            ),
          db
            .select({
              professionalId: appointments.professionalId,
              status: appointments.status,
              timeRange: appointments.timeRange,
              depositExpiresAt: deposits.expiresAt,
            })
            .from(appointments)
            .leftJoin(
              deposits,
              and(
                eq(deposits.tenantId, appointments.tenantId),
                eq(deposits.appointmentId, appointments.id),
              ),
            )
            .where(
              and(
                eq(appointments.tenantId, tenantId),
                inArray(appointments.professionalId, teamIds),
                inArray(appointments.status, OCCUPYING_STATUSES),
                overlaps(appointments.timeRange, around),
                input.excludeAppointmentId
                  ? ne(appointments.id, input.excludeAppointmentId)
                  : undefined,
              ),
            ),
        ]);

  const schedules: ProfessionalSchedule[] = team.map((professional) => ({
    id: professional.id,
    durationOverrideMinutes: professional.durationOverrideMinutes,
    weeklyHours: hours
      .filter((block) => block.professionalId === professional.id)
      .map((block) => ({ weekday: block.weekday, start: block.startTime, end: block.endTime })),
    busy: [
      ...occupiedRanges(
        booked.filter((appointment) => appointment.professionalId === professional.id),
        now,
      ),
      ...(input.calendarBusy?.get(professional.id) ?? []),
    ],
  }));

  const { settings } = business;
  return {
    service,
    settings,
    query: {
      now,
      timeZone: business.timezone,
      window,
      service: { durationMinutes: service.durationMinutes, bufferMinutes: service.bufferMinutes },
      professionals: schedules,
      exceptions: exceptions.map((exception) => ({
        professionalId: exception.professionalId,
        kind: exception.kind,
        range: exception.timeRange,
      })),
      holidays: holidayRows.map((holiday) => holiday.date),
      worksOnHolidays: settings.worksOnHolidays,
      rules: {
        slotGranularityMinutes: settings.slotGranularityMinutes,
        minBookingNoticeMinutes: settings.minBookingNoticeMinutes,
        maxBookingAdvanceDays: settings.maxBookingAdvanceDays,
      },
    },
  };
}
