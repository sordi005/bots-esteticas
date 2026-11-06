import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGoogleCalendarClient } from '../../src/modules/calendar/client.js';

/**
 * Contratos con la API de Google Calendar (sección 11.3). Google no publica respuestas de ejemplo
 * completas: los archivos de `google-calendar/` son respuestas reales del spike de H12 (04/11/2026)
 * contra una Gmail personal, con los ids y los mails cambiados. El turno con la seña en
 * verificación y la invitación rechazada de `events-list.json` se armaron con el mismo formato.
 * Formatos de developers.google.com/workspace/calendar/api/v3/reference/events.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`google-calendar/${name}.json`, import.meta.url), 'utf8'));
}

const respondWith =
  (status: number, body: unknown): typeof fetch =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

const clientFor = (status: number, name: string) =>
  createGoogleCalendarClient({ tokens: { get: () => Promise.resolve('ya29.token') }, fetch: respondWith(status, fixture(name)) });

const NOVEMBER_5 = { start: new Date('2026-11-05T03:00:00Z'), end: new Date('2026-11-06T03:00:00Z') };

describe('GET calendars/{id}/events', () => {
  it('lee el horario, si bloquea, si es un turno nuestro y si la profesional rechazó la invitación', async () => {
    const events = await clientFor(200, 'events-list').listEvents('duena@gmail.com', NOVEMBER_5);

    expect(events).toEqual([
      {
        id: '7kq2c0h1d9s6o8v3m5t1a2b4c6',
        cancelled: false,
        transparent: false,
        declined: false,
        appointmentId: null,
        start: { at: new Date('2026-11-05T13:00:00Z') },
        end: { at: new Date('2026-11-05T14:00:00Z') },
      },
      // Privado: llega igual, con su horario.
      expect.objectContaining({ id: '1fj9h3k5m7p0r2t4v6b8d0f2h4', transparent: false }),
      // "Disponible".
      expect.objectContaining({ id: '3lb5n7p9r1t3v5d7f9h1j3l5n7', transparent: true }),
      // De todo el día: fechas, con el fin exclusivo.
      expect.objectContaining({
        id: '5ad7f9h1j3l5n7p9r1t3v5b7d9',
        transparent: true,
        start: { date: '2026-11-05' },
        end: { date: '2026-11-06' },
      }),
      expect.objectContaining({
        id: 'cffcb42eef8b4a0e9f9b9b555253f017',
        appointmentId: 'cffcb42e-ef8b-4a0e-9f9b-9b555253f017',
        end: { at: new Date('2026-11-05T22:10:00Z') },
      }),
      expect.objectContaining({ id: '9pe1g3i5k7m9o1q3s5u7a9c1e3', declined: true }),
    ]);
  });
});

describe('POST calendars/{id}/events', () => {
  it('acepta el evento creado', async () => {
    await expect(
      clientFor(200, 'event-inserted').saveEvent('duena@gmail.com', {
        id: 'cffcb42eef8b4a0e9f9b9b555253f017',
        appointmentId: 'cffcb42e-ef8b-4a0e-9f9b-9b555253f017',
        summary: 'Semipermanente · Laura',
        description: 'Turno reservado por WhatsApp.',
        start: new Date('2026-11-03T21:00:00Z'),
        end: new Date('2026-11-03T22:00:00Z'),
        timeZone: 'America/Argentina/Mendoza',
        tentative: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('DELETE calendars/{id}/events/{eventId}', () => {
  it.each(['error-deleted', 'error-not-found'])('%s: el evento ya no está, así que borrarlo salió bien', async (name) => {
    const status = name === 'error-deleted' ? 410 : 404;

    await expect(clientFor(status, name).deleteEvent('duena@gmail.com', 'cffcb42eef8b4a0e9f9b9b555253f017')).resolves.toBeUndefined();
  });
});

describe('errores de Google', () => {
  it('lee el código y el motivo', async () => {
    const error = await clientFor(409, 'error-duplicate')
      .listEvents('duena@gmail.com', NOVEMBER_5)
      .catch((rejection: unknown) => rejection);

    expect(error).toMatchObject({ status: 409, reason: 'duplicate' });
    expect((error as Error).message).toContain('The requested identifier already exists.');
  });
});
