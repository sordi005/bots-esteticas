import type { CalendarEvent, CalendarEventInput, GoogleCalendarClient } from '../../../src/modules/calendar/client.js';
import type { TimestampRange } from '../../../src/shared/timestamp-range.js';

/** Un Google Calendar falso: anota lo que se le pide y devuelve los eventos cargados. */
export function fakeGoogleCalendar(options: { events?: CalendarEvent[]; fail?: Error } = {}) {
  const saved: { calendarId: string; event: CalendarEventInput }[] = [];
  const deleted: { calendarId: string; eventId: string }[] = [];
  const listed: { calendarId: string; range: TimestampRange }[] = [];

  const client: GoogleCalendarClient = {
    listEvents(calendarId, range) {
      listed.push({ calendarId, range });
      return options.fail ? Promise.reject(options.fail) : Promise.resolve(options.events ?? []);
    },
    saveEvent(calendarId, event) {
      if (options.fail) return Promise.reject(options.fail);
      saved.push({ calendarId, event });
      return Promise.resolve();
    },
    deleteEvent(calendarId, eventId) {
      if (options.fail) return Promise.reject(options.fail);
      deleted.push({ calendarId, eventId });
      return Promise.resolve();
    },
  };
  return { client, saved, deleted, listed };
}
