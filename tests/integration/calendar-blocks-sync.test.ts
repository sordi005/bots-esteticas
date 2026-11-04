import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { syncAppointmentEvent } from '../../src/modules/calendar/appointment-sync.js';
import { CALENDAR_SYNC_INTERVAL_MS, syncCalendarBlocks } from '../../src/modules/calendar/blocks-sync.js';
import type { CalendarEvent } from '../../src/modules/calendar/client.js';
import { GoogleApiError } from '../../src/modules/calendar/google-auth.js';
import { professionals } from '../../src/modules/catalog/schema.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { bookAppointment } from '../../src/modules/scheduling/booking.js';
import { calendarBlocks } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, type BookableFixture } from './support/fixtures.js';
import { fakeGoogleCalendar } from './support/google-calendar.js';

/**
 * La copia de los bloqueos del Google Calendar de una profesional (6.7, 8.4, D4 y D10): reemplaza
 * los guardados por los que están ocupados ahora, se vuelve a programar y avisa si alguien movió o
 * borró a mano el evento de un turno.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const SUNDAY_9 = at('2026-10-04', '09:00');
const SUNDAY_10 = at('2026-10-04', '10:00');
const MONDAY_10 = at('2026-10-05', '10:00');
const CALENDAR = 'mica@gmail.com';
const DAY_MS = 86_400_000;

async function fixtureWithCalendar(options: Parameters<typeof createBookableFixture>[1] = {}) {
  const fixture = await createBookableFixture(db, options);
  await db
    .update(professionals)
    .set({ googleCalendarId: CALENDAR })
    .where(and(eq(professionals.tenantId, fixture.tenantId), eq(professionals.id, fixture.professionalId)));
  return fixture;
}

function busy(start: Date, end: Date, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: `ev${String(start.getTime())}`,
    cancelled: false,
    transparent: false,
    declined: false,
    appointmentId: null,
    start: { at: start },
    end: { at: end },
    ...overrides,
  };
}

function run(fixture: BookableFixture, google: ReturnType<typeof fakeGoogleCalendar>, now = SUNDAY_10) {
  const lines: string[] = [];
  const logger = createLogger({ logLevel: 'debug' }, { write: (chunk: string) => void lines.push(chunk) });
  const result = syncCalendarBlocks(
    { db, logger, now: () => now, client: google.client },
    { tenantId: fixture.tenantId, professionalId: fixture.professionalId },
  );
  return { result, lines };
}

async function blocksOf(fixture: BookableFixture) {
  const rows = await db
    .select({ timeRange: calendarBlocks.timeRange })
    .from(calendarBlocks)
    .where(and(eq(calendarBlocks.tenantId, fixture.tenantId), eq(calendarBlocks.professionalId, fixture.professionalId)));
  return rows.map((row) => row.timeRange).sort((a, b) => a.start.getTime() - b.start.getTime());
}

function nextRunOf(fixture: BookableFixture) {
  return db
    .select({ key: scheduledJobs.key, runAt: scheduledJobs.runAt, payload: scheduledJobs.payload })
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.tenantId, fixture.tenantId), eq(scheduledJobs.kind, 'sync_calendar_blocks')));
}

const warnings = (lines: string[]) =>
  lines.map((line) => JSON.parse(line) as { level: number; msg: string; appointmentId?: string; problem?: string }).filter((line) => line.level === 40);

describe('syncCalendarBlocks: copia los eventos ocupados de la profesional (D4)', () => {
  it('lee desde ahora hasta la anticipación máxima y guarda solo lo que bloquea', async () => {
    const fixture = await fixtureWithCalendar();
    const google = fakeGoogleCalendar({
      events: [
        busy(MONDAY_10, at('2026-10-05', '11:00')),
        busy(at('2026-10-05', '15:00'), at('2026-10-05', '16:00'), { transparent: true }),
        busy(at('2026-10-06', '09:00'), at('2026-10-06', '10:00'), { appointmentId: 'cffcb42e-ef8b-4a0e-9f9b-9b555253f017' }),
      ],
    });

    expect(await run(fixture, google).result).toBe('synced');

    expect(google.listed).toEqual([
      // 30 días de anticipación máxima (por defecto), más un día por los turnos que la cruzan.
      { calendarId: CALENDAR, range: { start: SUNDAY_10, end: new Date(SUNDAY_10.getTime() + 31 * DAY_MS) } },
    ]);
    expect(await blocksOf(fixture)).toEqual([{ start: MONDAY_10, end: at('2026-10-05', '11:00') }]);
  });

  it('reemplaza los bloqueos anteriores: lo que se borró en el calendario deja de bloquear', async () => {
    const fixture = await fixtureWithCalendar();
    await run(fixture, fakeGoogleCalendar({ events: [busy(MONDAY_10, at('2026-10-05', '11:00'))] })).result;

    await run(fixture, fakeGoogleCalendar({ events: [busy(at('2026-10-06', '09:00'), at('2026-10-06', '12:00'))] })).result;

    expect(await blocksOf(fixture)).toEqual([{ start: at('2026-10-06', '09:00'), end: at('2026-10-06', '12:00') }]);
  });

  it('se vuelve a programar para dentro de 2 minutos', async () => {
    const fixture = await fixtureWithCalendar();

    await run(fixture, fakeGoogleCalendar()).result;

    expect(CALENDAR_SYNC_INTERVAL_MS).toBe(2 * 60_000);
    expect(await nextRunOf(fixture)).toEqual([
      {
        key: fixture.professionalId,
        runAt: new Date(SUNDAY_10.getTime() + CALENDAR_SYNC_INTERVAL_MS),
        payload: { professionalId: fixture.professionalId },
      },
    ]);
  });

  it('si Google falla, se vuelve a programar igual y quedan los últimos bloqueos copiados', async () => {
    const fixture = await fixtureWithCalendar();
    await run(fixture, fakeGoogleCalendar({ events: [busy(MONDAY_10, at('2026-10-05', '11:00'))] })).result;
    const failing = fakeGoogleCalendar({ fail: new GoogleApiError('Google respondió 503', 503, 'backendError') });

    await expect(run(fixture, failing, at('2026-10-04', '10:30')).result).rejects.toBeInstanceOf(GoogleApiError);

    expect(await blocksOf(fixture)).toEqual([{ start: MONDAY_10, end: at('2026-10-05', '11:00') }]);
    expect((await nextRunOf(fixture))[0]?.runAt).toEqual(new Date(at('2026-10-04', '10:30').getTime() + CALENDAR_SYNC_INTERVAL_MS));
  });

  it('si la profesional ya no tiene calendario, no lee nada y deja de programarse', async () => {
    const fixture = await createBookableFixture(db);
    const google = fakeGoogleCalendar();

    expect(await run(fixture, google).result).toBe('no_calendar');

    expect(google.listed).toEqual([]);
    expect(await nextRunOf(fixture)).toEqual([]);
  });
});

describe('syncCalendarBlocks: el evento de un turno editado a mano (8.4, D10)', () => {
  async function confirmedWithEvent() {
    const fixture = await fixtureWithCalendar({ settings: { depositRequirement: 'never' } });
    const booked = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: fixture.customerId,
      serviceId: fixture.serviceId,
      professionalId: fixture.professionalId,
      start: MONDAY_10,
      actor: 'assistant',
      now: SUNDAY_9,
    });
    if (!booked.ok) throw new Error(booked.reason);
    const google = fakeGoogleCalendar();
    await syncAppointmentEvent(
      { db, logger: createLogger({ logLevel: 'silent' }), now: () => SUNDAY_9, client: google.client },
      { tenantId: fixture.tenantId, appointmentId: booked.appointmentId },
    );
    // La tarea del turno ya corrió.
    await db.update(scheduledJobs).set({ status: 'done' }).where(eq(scheduledJobs.tenantId, fixture.tenantId));
    const ours = (start: Date, end: Date) => busy(start, end, { id: booked.appointmentId.replaceAll('-', ''), appointmentId: booked.appointmentId });
    return { fixture, appointmentId: booked.appointmentId, ours };
  }

  it('en su lugar, no avisa nada', async () => {
    const { fixture, ours } = await confirmedWithEvent();

    const { result, lines } = run(fixture, fakeGoogleCalendar({ events: [ours(MONDAY_10, at('2026-10-05', '11:00'))] }));
    await result;

    expect(warnings(lines)).toEqual([]);
  });

  it('movido a mano: lo avisa en el log, sin tocar el turno ni el evento', async () => {
    const { fixture, appointmentId, ours } = await confirmedWithEvent();
    const google = fakeGoogleCalendar({ events: [ours(at('2026-10-05', '12:00'), at('2026-10-05', '13:00'))] });

    const { result, lines } = run(fixture, google);
    await result;

    expect(warnings(lines)).toEqual([expect.objectContaining({ appointmentId, problem: 'moved' })]);
    expect(google.saved).toEqual([]);
  });

  it('borrado a mano: lo avisa en el log', async () => {
    const { fixture, appointmentId } = await confirmedWithEvent();

    const { result, lines } = run(fixture, fakeGoogleCalendar({ events: [] }));
    await result;

    expect(warnings(lines)).toEqual([expect.objectContaining({ appointmentId, problem: 'deleted' })]);
  });

  it('si la tarea del turno todavía no corrió, no es una edición a mano', async () => {
    const { fixture } = await confirmedWithEvent();
    await db.update(scheduledJobs).set({ status: 'pending' }).where(and(eq(scheduledJobs.tenantId, fixture.tenantId), eq(scheduledJobs.kind, 'sync_appointment_event')));

    const { result, lines } = run(fixture, fakeGoogleCalendar({ events: [] }));
    await result;

    expect(warnings(lines)).toEqual([]);
  });
});
