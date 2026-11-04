import { localDateTimeToInstant } from '../../shared/time-zone.js';
import type { TimestampRange } from '../../shared/timestamp-range.js';
import type { CalendarEvent, EventTime } from './client.js';

/**
 * Los horarios que bloquean los eventos del calendario de una profesional (4.2, D5). Bloquea lo
 * que Google muestra "Ocupado": no lo "Disponible", ni lo cancelado, ni una invitación rechazada,
 * ni los eventos de nuestros turnos, que ya ocupan el horario como turnos. Un evento de todo el
 * día va de medianoche a medianoche en la zona horaria del negocio. Función pura.
 */
export function busyBlocks(events: readonly CalendarEvent[], timeZone: string): TimestampRange[] {
  const toInstant = (time: EventTime) => ('at' in time ? time.at : localDateTimeToInstant(time.date, '00:00', timeZone));

  return events
    .filter((event) => !event.transparent && !event.cancelled && !event.declined && event.appointmentId === null)
    .map((event) => ({ start: toInstant(event.start), end: toInstant(event.end) }))
    .filter((block) => block.end.getTime() > block.start.getTime());
}
