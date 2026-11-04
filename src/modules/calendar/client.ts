import { z } from 'zod';
import type { LocalDate } from '../../shared/time-zone.js';
import type { TimestampRange } from '../../shared/timestamp-range.js';
import { GoogleApiError, type AccessTokenSource } from './google-auth.js';

/**
 * Cliente de la API de Google Calendar (8.4), con `fetch` y Zod en vez de la librería oficial
 * (decisión 46). Recibe `fetch` por parámetro para probarlo sin red. Formatos de
 * developers.google.com/workspace/calendar/api/v3/reference/events. Nunca pide títulos ni
 * descripciones de los eventos de la profesional: pueden ser datos de salud (4.9).
 */

/** Un instante, o una fecha si el evento es de todo el día (el fin es exclusivo). */
export type EventTime = { at: Date } | { date: LocalDate };

export interface CalendarEvent {
  id: string;
  cancelled: boolean;
  /** "Disponible": no bloquea el horario (4.2). */
  transparent: boolean;
  /** La profesional rechazó la invitación. */
  declined: boolean;
  /** La marca privada de un evento de turno escrito por el sistema (8.4). */
  appointmentId: string | null;
  start: EventTime;
  end: EventTime;
}

/** Un evento de turno (8.4). */
export interface CalendarEventInput {
  /** El id del turno sin guiones: base32hex, como pide Google. */
  id: string;
  appointmentId: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timeZone: string;
  /** Provisorio: la seña está en verificación. */
  tentative: boolean;
}

export interface GoogleCalendarClient {
  /** Los eventos sueltos (las repeticiones, expandidas) que se superponen con `range`. */
  listEvents(calendarId: string, range: TimestampRange): Promise<CalendarEvent[]>;
  /** Crea el evento con su id; si ya existe, aunque esté borrado, lo actualiza (D7). */
  saveEvent(calendarId: string, event: CalendarEventInput): Promise<void>;
  /** Si el evento ya no está, también salió bien. */
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

const BASE_URL = 'https://www.googleapis.com/calendar/v3';
/** Solo lo que hace falta para bloquear horarios: nada de títulos, descripciones ni lugares. */
const LIST_FIELDS =
  'items(id,status,transparency,start(date,dateTime),end(date,dateTime),attendees(self,responseStatus),extendedProperties(private)),nextPageToken';
const PAGE_SIZE = '2500';

const eventTime = z
  .object({ dateTime: z.iso.datetime({ offset: true }).optional(), date: z.iso.date().optional() })
  .transform((time, context): EventTime => {
    if (time.dateTime) return { at: new Date(time.dateTime) };
    if (time.date) return { date: time.date };
    context.addIssue({ code: 'custom', message: 'El evento no tiene ni fecha ni hora' });
    return z.NEVER;
  });

const eventResource = z
  .object({
    id: z.string().min(1),
    status: z.string().optional(),
    transparency: z.string().optional(),
    start: eventTime,
    end: eventTime,
    attendees: z.array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(),
    extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
  })
  .transform(
    (event): CalendarEvent => ({
      id: event.id,
      cancelled: event.status === 'cancelled',
      transparent: event.transparency === 'transparent',
      declined: event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === 'declined') ?? false,
      appointmentId: event.extendedProperties?.private?.appointmentId ?? null,
      start: event.start,
      end: event.end,
    }),
  );

const eventsPage = z.object({ items: z.array(eventResource).default([]), nextPageToken: z.string().optional() });

const errorResponse = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

function apiError(action: string, status: number, body: unknown): GoogleApiError {
  const parsed = errorResponse.safeParse(body);
  const message = parsed.success ? parsed.data.error.message : undefined;
  return new GoogleApiError(
    message ? `Google Calendar rechazó ${action}: ${message}` : `Google Calendar respondió ${String(status)} a ${action}`,
    status,
    parsed.success ? (parsed.data.error.errors?.[0]?.reason ?? null) : null,
  );
}

function eventBody(event: CalendarEventInput) {
  return {
    id: event.id,
    summary: event.summary,
    description: event.description,
    start: { dateTime: event.start.toISOString(), timeZone: event.timeZone },
    end: { dateTime: event.end.toISOString(), timeZone: event.timeZone },
    status: event.tentative ? 'tentative' : 'confirmed',
    extendedProperties: { private: { appointmentId: event.appointmentId } },
    reminders: { useDefault: true },
  };
}

export function createGoogleCalendarClient(options: {
  tokens: AccessTokenSource;
  fetch?: typeof fetch;
}): GoogleCalendarClient {
  const request = options.fetch ?? globalThis.fetch;

  async function call(
    action: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: URL,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const response = await request(url, {
      method,
      headers: {
        authorization: `Bearer ${await options.tokens.get()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw apiError(action, response.status, json);
    return { status: response.status, json };
  }

  const eventsUrl = (calendarId: string, eventId?: string) =>
    new URL(
      `${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`,
    );

  return {
    async listEvents(calendarId, range) {
      const events: CalendarEvent[] = [];
      let pageToken: string | undefined;
      do {
        const url = eventsUrl(calendarId);
        url.searchParams.set('singleEvents', 'true');
        url.searchParams.set('timeMin', range.start.toISOString());
        url.searchParams.set('timeMax', range.end.toISOString());
        url.searchParams.set('maxResults', PAGE_SIZE);
        url.searchParams.set('fields', LIST_FIELDS);
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const page = eventsPage.parse((await call('la lectura de eventos', 'GET', url)).json);
        events.push(...page.items);
        pageToken = page.nextPageToken;
      } while (pageToken);
      return events;
    },

    async saveEvent(calendarId, event) {
      const body = eventBody(event);
      try {
        await call('la creación del evento', 'POST', eventsUrl(calendarId), body);
      } catch (error) {
        if (!(error instanceof GoogleApiError && error.status === 409)) throw error;
        await call('la actualización del evento', 'PUT', eventsUrl(calendarId, event.id), body);
      }
    },

    async deleteEvent(calendarId, eventId) {
      try {
        await call('el borrado del evento', 'DELETE', eventsUrl(calendarId, eventId));
      } catch (error) {
        if (error instanceof GoogleApiError && (error.status === 404 || error.status === 410)) return;
        throw error;
      }
    },
  };
}
