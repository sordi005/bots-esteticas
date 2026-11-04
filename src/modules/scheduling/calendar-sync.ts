import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../../shared/db.js';
import type { TimestampRange } from '../../shared/timestamp-range.js';
import { appointments, calendarBlocks } from './schema.js';

/**
 * Lo que la sincronización con Google Calendar (8.4) guarda en el dominio. `scheduling` no sabe de
 * Google: recibe horarios y ids ya resueltos por el módulo `calendar`.
 */

/** Anota el evento que refleja el turno, o null si se borró. No cambia nada del turno en sí. */
export async function setAppointmentCalendarEvent(
  db: Queryable,
  input: { tenantId: string; appointmentId: string; eventId: string | null },
): Promise<void> {
  await db
    .update(appointments)
    .set({ calendarEventId: input.eventId })
    .where(and(eq(appointments.tenantId, input.tenantId), eq(appointments.id, input.appointmentId)));
}

/**
 * Reemplaza los bloqueos de una profesional por los recién leídos de su calendario (6.7, D4). Se
 * leen desde ahora hasta la anticipación máxima, que es todo lo que se puede reservar: lo de antes
 * ya pasó y lo de después no se ofrece, así que se reemplaza todo.
 */
export async function replaceCalendarBlocks(
  db: Queryable,
  input: { tenantId: string; professionalId: string; blocks: readonly TimestampRange[] },
): Promise<void> {
  const { tenantId, professionalId } = input;
  await db
    .delete(calendarBlocks)
    .where(and(eq(calendarBlocks.tenantId, tenantId), eq(calendarBlocks.professionalId, professionalId)));
  if (input.blocks.length > 0) {
    await db
      .insert(calendarBlocks)
      .values(input.blocks.map((timeRange) => ({ tenantId, professionalId, timeRange })));
  }
}
