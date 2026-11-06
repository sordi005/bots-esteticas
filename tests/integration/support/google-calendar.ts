import type { CalendarEvent, CalendarEventInput, GoogleCalendarClient } from '../../../src/modules/calendar/client.js';
import type { TimestampRange } from '../../../src/shared/timestamp-range.js';

/** Un Google Calendar falso: anota lo que se le pide y devuelve los eventos cargados. */
export function fakeGoogleCalendar(
  options: { events?: CalendarEvent[]; fail?: Error; failOn?: 'list' | 'save' | 'delete' } = {},
) {
  const failing = (operation: 'list' | 'save' | 'delete') =>
    options.fail && (!options.failOn || options.failOn === operation) ? options.fail : null;
  const saved: { calendarId: string; event: CalendarEventInput }[] = [];
  const deleted: { calendarId: string; eventId: string }[] = [];
  const listed: { calendarId: string; range: TimestampRange }[] = [];

  const client: GoogleCalendarClient = {
    listEvents(calendarId, range) {
      listed.push({ calendarId, range });
      const error = failing('list');
      return error ? Promise.reject(error) : Promise.resolve(options.events ?? []);
    },
    saveEvent(calendarId, event) {
      const error = failing('save');
      if (error) return Promise.reject(error);
      saved.push({ calendarId, event });
      return Promise.resolve();
    },
    deleteEvent(calendarId, eventId) {
      const error = failing('delete');
      if (error) return Promise.reject(error);
      deleted.push({ calendarId, eventId });
      return Promise.resolve();
    },
  };
  return { client, saved, deleted, listed };
}
