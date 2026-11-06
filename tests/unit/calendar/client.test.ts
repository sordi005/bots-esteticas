import { describe, expect, it } from 'vitest';
import { createGoogleCalendarClient, type CalendarEventInput } from '../../../src/modules/calendar/client.js';
import { GoogleApiError } from '../../../src/modules/calendar/google-auth.js';

const TOKEN = 'ya29.token-secreto';
const CALENDAR = 'duena@gmail.com';
const RANGE = { start: new Date('2026-11-05T03:00:00Z'), end: new Date('2026-12-05T03:00:00Z') };

interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

function googleError(code: number, reason: string, message = reason) {
  return { error: { errors: [{ domain: 'global', reason, message }], code, message } };
}

/** La URL de un pedido a `fetch`, sea texto, `URL` o `Request`. */
const urlOf = (input: string | URL | Request) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/** Un Google falso: devuelve las respuestas en orden y anota cada pedido. */
function fakeGoogle(...responses: { status: number; body?: unknown }[]) {
  const requests: Recorded[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    requests.push({
      method: init?.method ?? 'GET',
      url: new URL(urlOf(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift() ?? { status: 500 };
    return Promise.resolve(
      next.body === undefined
        ? new Response(null, { status: next.status })
        : new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } }),
    );
  };
  const client = createGoogleCalendarClient({ tokens: { get: () => Promise.resolve(TOKEN) }, fetch: fetchFn });
  return { client, requests };
}

const EVENT: CalendarEventInput = {
  id: 'cffcb42eef8b4a0e9f9b9b555253f017',
  appointmentId: 'cffcb42e-ef8b-4a0e-9f9b-9b555253f017',
  summary: 'Semipermanente · Laura',
  description: 'Turno reservado por WhatsApp.',
  start: new Date('2026-11-05T13:00:00Z'),
  end: new Date('2026-11-05T14:00:00Z'),
  timeZone: 'America/Argentina/Mendoza',
  tentative: false,
};

const timed = (id: string) => ({
  id,
  status: 'confirmed',
  start: { dateTime: '2026-11-05T10:00:00-03:00' },
  end: { dateTime: '2026-11-05T11:00:00-03:00' },
});

describe('GoogleCalendarClient.listEvents', () => {
  it('pide los eventos sueltos de la ventana, sin títulos ni descripciones, con el token', async () => {
    const google = fakeGoogle({ status: 200, body: { items: [] } });

    await google.client.listEvents(CALENDAR, RANGE);

    const [request] = google.requests;
    expect(request?.method).toBe('GET');
    expect(request?.url.pathname).toBe('/calendar/v3/calendars/duena%40gmail.com/events');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    const params = request?.url.searchParams;
    expect(params?.get('singleEvents')).toBe('true');
    expect(params?.get('timeMin')).toBe('2026-11-05T03:00:00.000Z');
    expect(params?.get('timeMax')).toBe('2026-12-05T03:00:00.000Z');
    expect(params?.get('fields')).not.toMatch(/summary|description|location/);
  });

  it('sigue las páginas hasta la última', async () => {
    const google = fakeGoogle(
      { status: 200, body: { items: [timed('aaaaa')], nextPageToken: 'pagina-2' } },
      { status: 200, body: { items: [timed('bbbbb')] } },
    );

    const events = await google.client.listEvents(CALENDAR, RANGE);

    expect(events.map((event) => event.id)).toEqual(['aaaaa', 'bbbbb']);
    expect(google.requests[1]?.url.searchParams.get('pageToken')).toBe('pagina-2');
    expect(google.requests[1]?.url.searchParams.get('singleEvents')).toBe('true');
  });

  it('un calendario sin compartir es un error con su código, que no muestra el token', async () => {
    const google = fakeGoogle({ status: 404, body: googleError(404, 'notFound', 'Not Found') });

    const error = await google.client.listEvents(CALENDAR, RANGE).catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ status: 404, reason: 'notFound' });
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe('GoogleCalendarClient.saveEvent (D7)', () => {
  it('crea el evento con su id, la marca del turno y los recordatorios de la profesional', async () => {
    const google = fakeGoogle({ status: 200, body: { id: EVENT.id } });

    await google.client.saveEvent(CALENDAR, EVENT);

    expect(google.requests).toHaveLength(1);
    const [request] = google.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url.pathname).toBe('/calendar/v3/calendars/duena%40gmail.com/events');
    expect(request?.body).toEqual({
      id: EVENT.id,
      summary: 'Semipermanente · Laura',
      description: 'Turno reservado por WhatsApp.',
      start: { dateTime: '2026-11-05T13:00:00.000Z', timeZone: 'America/Argentina/Mendoza' },
      end: { dateTime: '2026-11-05T14:00:00.000Z', timeZone: 'America/Argentina/Mendoza' },
      status: 'confirmed',
      extendedProperties: { private: { appointmentId: EVENT.appointmentId } },
      reminders: { useDefault: true },
    });
  });

  it('provisorio: el evento va como tentative', async () => {
    const google = fakeGoogle({ status: 200, body: { id: EVENT.id } });

    await google.client.saveEvent(CALENDAR, { ...EVENT, tentative: true });

    expect(google.requests[0]?.body).toMatchObject({ status: 'tentative' });
  });

  it('si el id ya existe (un reintento, o un evento borrado), lo actualiza con lo mismo', async () => {
    const google = fakeGoogle(
      { status: 409, body: googleError(409, 'duplicate') },
      { status: 200, body: { id: EVENT.id } },
    );

    await google.client.saveEvent(CALENDAR, EVENT);

    const [insert, update] = google.requests;
    expect(update?.method).toBe('PUT');
    expect(update?.url.pathname).toBe(`/calendar/v3/calendars/duena%40gmail.com/events/${EVENT.id}`);
    expect(update?.body).toEqual(insert?.body);
  });

  it('otro error no se disimula', async () => {
    const google = fakeGoogle({ status: 403, body: googleError(403, 'forbidden', 'You need to have writer access to this calendar.') });

    await expect(google.client.saveEvent(CALENDAR, EVENT)).rejects.toMatchObject({ status: 403, reason: 'forbidden' });
  });
});

describe('GoogleCalendarClient.deleteEvent', () => {
  it('borra el evento por su id', async () => {
    const google = fakeGoogle({ status: 204 });

    await google.client.deleteEvent(CALENDAR, EVENT.id);

    expect(google.requests[0]?.method).toBe('DELETE');
    expect(google.requests[0]?.url.pathname).toBe(`/calendar/v3/calendars/duena%40gmail.com/events/${EVENT.id}`);
  });

  it('un error del servidor no se disimula', async () => {
    const google = fakeGoogle({ status: 503, body: googleError(503, 'backendError') });

    await expect(google.client.deleteEvent(CALENDAR, EVENT.id)).rejects.toMatchObject({ status: 503 });
  });
});
