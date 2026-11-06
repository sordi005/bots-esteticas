import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { professionals, services } from '../catalog/schema.js';
import { customers } from '../customers/schema.js';
import type { JobHandler } from '../jobs/runner.js';
import { calendarSyncPayloadSchema } from '../scheduling/appointment-jobs.js';
import { setAppointmentCalendarEvent } from '../scheduling/calendar-sync.js';
import { appointments } from '../scheduling/schema.js';
import { tenants } from '../tenants/schema.js';
import { appointmentEventAction } from './appointment-event.js';
import type { GoogleCalendarClient } from './client.js';

export interface CalendarDependencies {
  db: NodePgDatabase;
  logger: Logger;
  now: () => Date;
  client: GoogleCalendarClient;
}

export type AppointmentSyncResult = 'saved' | 'deleted' | 'kept' | 'no_calendar' | 'not_found';

/**
 * Deja el evento del turno como corresponde a su estado y horario actuales (8.4, D6–D8). No sabe
 * qué cambió, así que correrla dos veces da lo mismo (regla 7). Borrar un evento que no existe sale
 * bien: no hace falta saber si se llegó a crear.
 */
export async function syncAppointmentEvent(
  deps: CalendarDependencies,
  input: { tenantId: string; appointmentId: string },
): Promise<AppointmentSyncResult> {
  const { db, client } = deps;
  const { tenantId, appointmentId } = input;

  const [row] = await db
    .select({
      status: appointments.status,
      timeRange: appointments.timeRange,
      durationMinutes: appointments.durationMinutes,
      calendarId: professionals.googleCalendarId,
      serviceName: services.name,
      customerName: customers.name,
      profileName: customers.whatsappProfileName,
      timeZone: tenants.timezone,
    })
    .from(appointments)
    .innerJoin(
      professionals,
      and(eq(professionals.tenantId, appointments.tenantId), eq(professionals.id, appointments.professionalId)),
    )
    .innerJoin(services, and(eq(services.tenantId, appointments.tenantId), eq(services.id, appointments.serviceId)))
    .innerJoin(customers, and(eq(customers.tenantId, appointments.tenantId), eq(customers.id, appointments.customerId)))
    .innerJoin(tenants, eq(tenants.id, appointments.tenantId))
    .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId)));
  if (!row) return 'not_found';
  if (!row.calendarId) return 'no_calendar';

  const action = appointmentEventAction({
    appointmentId,
    status: row.status,
    serviceName: row.serviceName,
    customerName: row.customerName,
    profileName: row.profileName,
    start: row.timeRange.start,
    durationMinutes: row.durationMinutes,
    timeZone: row.timeZone,
  });

  switch (action.kind) {
    case 'keep':
      return 'kept';
    case 'save':
      await client.saveEvent(row.calendarId, action.event);
      await setAppointmentCalendarEvent(db, { tenantId, appointmentId, eventId: action.event.id });
      return 'saved';
    case 'delete':
      await client.deleteEvent(row.calendarId, action.eventId);
      await setAppointmentCalendarEvent(db, { tenantId, appointmentId, eventId: null });
      return 'deleted';
  }
}

export function appointmentEventJobHandler(deps: CalendarDependencies): JobHandler {
  return async (job) => {
    const { appointmentId } = calendarSyncPayloadSchema.parse(job.payload);
    const result = await syncAppointmentEvent(deps, { tenantId: job.tenantId, appointmentId });
    deps.logger.info({ tenantId: job.tenantId, appointmentId, result }, 'Turno reflejado en Google Calendar');
  };
}
