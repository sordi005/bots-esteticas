import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { professionals, services } from '../catalog/schema.js';
import { deposits, type depositStatus } from '../payments/schema.js';
import type { Queryable } from '../../shared/db.js';
import {
  APPOINTMENT_STATUSES,
  occupiesSchedule,
  type AppointmentStatus,
} from './appointment-state-machine.js';
import { holdsSchedule } from './availability.js';
import { appointments } from './schema.js';

/**
 * Los turnos de UNA clienta (4.6): lo que necesita el asistente para mostrárselos, cancelarlos o
 * reprogramarlos. Toda consulta filtra por negocio y por clienta (reglas 1 y 2): el turno de
 * otra clienta del mismo negocio no existe para quien pregunta.
 */

export interface CustomerAppointment {
  id: string;
  status: AppointmentStatus;
  /** Inicio del turno que ve la clienta (el margen posterior no cuenta). */
  start: Date;
  durationMinutes: number;
  serviceId: string;
  serviceName: string;
  professionalId: string;
  professionalName: string;
  /** Null si el turno no lleva seña. */
  deposit: {
    amountCents: number;
    status: (typeof depositStatus.enumValues)[number];
    expiresAt: Date;
  } | null;
}

const OCCUPYING_STATUSES = APPOINTMENT_STATUSES.filter(occupiesSchedule);

async function selectCustomerAppointments(
  db: Queryable,
  filters: ReturnType<typeof and>,
): Promise<CustomerAppointment[]> {
  const rows = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      timeRange: appointments.timeRange,
      durationMinutes: appointments.durationMinutes,
      serviceId: appointments.serviceId,
      serviceName: services.name,
      professionalId: appointments.professionalId,
      professionalName: professionals.name,
      depositAmountCents: deposits.amountCents,
      depositStatus: deposits.status,
      depositExpiresAt: deposits.expiresAt,
    })
    .from(appointments)
    .innerJoin(
      services,
      and(eq(services.tenantId, appointments.tenantId), eq(services.id, appointments.serviceId)),
    )
    .innerJoin(
      professionals,
      and(
        eq(professionals.tenantId, appointments.tenantId),
        eq(professionals.id, appointments.professionalId),
      ),
    )
    .leftJoin(
      deposits,
      and(eq(deposits.tenantId, appointments.tenantId), eq(deposits.appointmentId, appointments.id)),
    )
    .where(filters)
    .orderBy(asc(sql`lower(${appointments.timeRange})`), asc(appointments.id));

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    start: row.timeRange.start,
    durationMinutes: row.durationMinutes,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    professionalId: row.professionalId,
    professionalName: row.professionalName,
    deposit:
      row.depositAmountCents !== null && row.depositStatus !== null && row.depositExpiresAt !== null
        ? { amountCents: row.depositAmountCents, status: row.depositStatus, expiresAt: row.depositExpiresAt }
        : null,
  }));
}

/** Un turno de esta clienta en este negocio, o null si no existe o es de otra persona. */
export async function findCustomerAppointment(
  db: Queryable,
  input: { tenantId: string; customerId: string; appointmentId: string },
): Promise<CustomerAppointment | null> {
  const [appointment] = await selectCustomerAppointments(
    db,
    and(
      eq(appointments.tenantId, input.tenantId),
      eq(appointments.customerId, input.customerId),
      eq(appointments.id, input.appointmentId),
    ),
  );
  return appointment ?? null;
}

/**
 * Hasta `limit` turnos futuros que ocupan el horario (4.3), del más cercano al más lejano. Una
 * seña pendiente vencida no cuenta aunque la tarea programada todavía no haya vencido el turno.
 */
export async function listUpcomingCustomerAppointments(
  db: Queryable,
  input: { tenantId: string; customerId: string; now: Date; limit: number },
): Promise<CustomerAppointment[]> {
  const { tenantId, customerId, now, limit } = input;
  const upcoming = await selectCustomerAppointments(
    db,
    and(
      eq(appointments.tenantId, tenantId),
      eq(appointments.customerId, customerId),
      inArray(appointments.status, OCCUPYING_STATUSES),
      gt(sql`lower(${appointments.timeRange})`, now),
    ),
  );
  return upcoming
    .filter((appointment) =>
      holdsSchedule({ status: appointment.status, depositExpiresAt: appointment.deposit?.expiresAt ?? null }, now),
    )
    .slice(0, limit);
}

/**
 * El turno de esta clienta que ocupa el horario con ese mismo servicio, profesional e inicio, o
 * null. Sirve para que reservar dos veces lo mismo (un reintento) devuelva el turno que ya está
 * en vez de decir que el horario se ocupó.
 */
export async function findCustomerAppointmentAt(
  db: Queryable,
  input: {
    tenantId: string;
    customerId: string;
    serviceId: string;
    professionalId: string;
    start: Date;
    now: Date;
  },
): Promise<CustomerAppointment | null> {
  const candidates = await selectCustomerAppointments(
    db,
    and(
      eq(appointments.tenantId, input.tenantId),
      eq(appointments.customerId, input.customerId),
      eq(appointments.serviceId, input.serviceId),
      eq(appointments.professionalId, input.professionalId),
      inArray(appointments.status, OCCUPYING_STATUSES),
      eq(sql`lower(${appointments.timeRange})`, input.start),
    ),
  );
  return (
    candidates.find((appointment) =>
      holdsSchedule(
        { status: appointment.status, depositExpiresAt: appointment.deposit?.expiresAt ?? null },
        input.now,
      ),
    ) ?? null
  );
}
