import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { APPOINTMENT_EVENT_DESCRIPTION } from '../../src/modules/calendar/appointment-event.js';
import { syncAppointmentEvent } from '../../src/modules/calendar/appointment-sync.js';
import { GoogleApiError } from '../../src/modules/calendar/google-auth.js';
import { professionals } from '../../src/modules/catalog/schema.js';
import { bookAppointment, changeAppointmentStatus, rescheduleAppointment } from '../../src/modules/scheduling/booking.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, type BookableFixture } from './support/fixtures.js';
import { fakeGoogleCalendar } from './support/google-calendar.js';

/**
 * La tarea que refleja un turno en el Google Calendar de la profesional (8.4, D6–D8). Lee el estado
 * actual del turno: repetirla deja el calendario igual (regla 7).
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = pino({ level: 'silent' });

afterAll(() => database.close());

const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const SUNDAY_9 = at('2026-10-04', '09:00');
const SUNDAY_11 = at('2026-10-04', '11:00');
const MONDAY_10 = at('2026-10-05', '10:00');
const MONDAY_12 = at('2026-10-05', '12:00');
const CALENDAR = 'mica@gmail.com';

async function fixtureWithCalendar(settings: Parameters<typeof createBookableFixture>[1] = {}) {
  const fixture = await createBookableFixture(db, settings);
  await db
    .update(professionals)
    .set({ googleCalendarId: CALENDAR })
    .where(and(eq(professionals.tenantId, fixture.tenantId), eq(professionals.id, fixture.professionalId)));
  return fixture;
}

async function book(fixture: BookableFixture) {
  const result = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: MONDAY_10,
    actor: 'assistant',
    now: SUNDAY_9,
  });
  if (!result.ok) throw new Error(`No se pudo reservar: ${result.reason}`);
  return result.appointmentId;
}

function sync(fixture: BookableFixture, appointmentId: string, google = fakeGoogleCalendar()) {
  return {
    google,
    result: syncAppointmentEvent({ db, logger, now: () => SUNDAY_11, client: google.client }, { tenantId: fixture.tenantId, appointmentId }),
  };
}

async function eventIdOf(fixture: BookableFixture, appointmentId: string) {
  const [row] = await db
    .select({ calendarEventId: appointments.calendarEventId })
    .from(appointments)
    .where(and(eq(appointments.tenantId, fixture.tenantId), eq(appointments.id, appointmentId)));
  return row?.calendarEventId;
}

const noDeposit = { settings: { depositRequirement: 'never' as const } };

describe('syncAppointmentEvent: el turno en el Google Calendar de la profesional (8.4)', () => {
  it('un turno confirmado aparece en su calendario, y queda anotado el id del evento', async () => {
    const fixture = await fixtureWithCalendar(noDeposit);
    const appointmentId = await book(fixture);

    const { google, result } = sync(fixture, appointmentId);

    expect(await result).toBe('saved');
    expect(google.saved).toEqual([
      {
        calendarId: CALENDAR,
        event: {
          id: appointmentId.replaceAll('-', ''),
          appointmentId,
          summary: 'Esmaltado semipermanente · Caro Pérez',
          description: APPOINTMENT_EVENT_DESCRIPTION,
          start: MONDAY_10,
          end: at('2026-10-05', '11:00'),
          timeZone: 'America/Argentina/Mendoza',
          tentative: false,
        },
      },
    ]);
    expect(await eventIdOf(fixture, appointmentId)).toBe(appointmentId.replaceAll('-', ''));
  });

  it('reprogramado, el evento se mueve al horario nuevo', async () => {
    const fixture = await fixtureWithCalendar(noDeposit);
    const appointmentId = await book(fixture);
    await rescheduleAppointment(db, { tenantId: fixture.tenantId, appointmentId, newStart: MONDAY_12, actor: 'assistant', now: SUNDAY_11 });

    const { google, result } = sync(fixture, appointmentId);

    expect(await result).toBe('saved');
    expect(google.saved[0]?.event).toMatchObject({ start: MONDAY_12, end: at('2026-10-05', '13:00') });
  });

  it('cancelado, el evento se borra y deja de estar anotado', async () => {
    const fixture = await fixtureWithCalendar(noDeposit);
    const appointmentId = await book(fixture);
    await sync(fixture, appointmentId).result;
    await changeAppointmentStatus(db, { tenantId: fixture.tenantId, appointmentId, to: 'CANCELLED_BY_CUSTOMER', actor: 'assistant', now: SUNDAY_11 });

    const { google, result } = sync(fixture, appointmentId);

    expect(await result).toBe('deleted');
    expect(google.deleted).toEqual([{ calendarId: CALENDAR, eventId: appointmentId.replaceAll('-', '') }]);
    expect(await eventIdOf(fixture, appointmentId)).toBeNull();
  });

  it('pendiente de seña no tiene evento', async () => {
    const fixture = await fixtureWithCalendar();
    const appointmentId = await book(fixture);

    const { google, result } = sync(fixture, appointmentId);

    expect(await result).toBe('deleted');
    expect(google.saved).toEqual([]);
  });

  it('repetida, deja el calendario igual', async () => {
    const fixture = await fixtureWithCalendar(noDeposit);
    const appointmentId = await book(fixture);
    const google = fakeGoogleCalendar();

    await sync(fixture, appointmentId, google).result;
    await sync(fixture, appointmentId, google).result;

    expect(google.saved.map((call) => call.event)).toEqual([google.saved[0]?.event, google.saved[0]?.event]);
  });

  it('si la profesional desconectó su calendario, no hace nada', async () => {
    const fixture = await createBookableFixture(db, noDeposit);
    const appointmentId = await book(fixture);

    const { google, result } = sync(fixture, appointmentId);

    expect(await result).toBe('no_calendar');
    expect(google.saved).toEqual([]);
    expect(google.deleted).toEqual([]);
  });

  it('si Google falla, la tarea falla (y se reintenta) sin anotar el evento', async () => {
    const fixture = await fixtureWithCalendar(noDeposit);
    const appointmentId = await book(fixture);
    const google = fakeGoogleCalendar({ fail: new GoogleApiError('Google respondió 503', 503, 'backendError') });

    await expect(sync(fixture, appointmentId, google).result).rejects.toBeInstanceOf(GoogleApiError);
    expect(await eventIdOf(fixture, appointmentId)).toBeNull();
  });

  it('un turno de otro negocio no se encuentra', async () => {
    const fixture = await fixtureWithCalendar(noDeposit);
    const other = await fixtureWithCalendar(noDeposit);
    const appointmentId = await book(other);

    expect(await sync(fixture, appointmentId).result).toBe('not_found');
  });
});
