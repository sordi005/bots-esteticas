import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import type { CalendarEvent } from '../../src/modules/calendar/client.js';
import { professionals } from '../../src/modules/catalog/schema.js';
import { scheduleJob } from '../../src/modules/jobs/queue.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { bookAppointment } from '../../src/modules/scheduling/booking.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { buildWorker } from '../../src/worker.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, type BookableFixture } from './support/fixtures.js';
import { fakeGoogleCalendar } from './support/google-calendar.js';

/** Criterio de H12, con el worker: el turno aparece en el calendario y un bloqueo se respeta (13). */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = createLogger({ logLevel: 'silent' });

afterAll(() => database.close());

// La cola es una sola para todos los negocios: un claim tomaría las tareas de otro test.
beforeEach(async () => {
  await db.delete(scheduledJobs);
});

const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const SUNDAY_9 = at('2026-10-04', '09:00');
const MONDAY_10 = at('2026-10-05', '10:00');
const CALENDAR = 'mica@gmail.com';

async function fixtureWithCalendar() {
  const fixture = await createBookableFixture(db, { settings: { depositRequirement: 'never' } });
  await db
    .update(professionals)
    .set({ googleCalendarId: CALENDAR })
    .where(and(eq(professionals.tenantId, fixture.tenantId), eq(professionals.id, fixture.professionalId)));
  return fixture;
}

const book = (fixture: BookableFixture) =>
  bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: MONDAY_10,
    actor: 'assistant',
    now: SUNDAY_9,
  });

const medicalAppointment: CalendarEvent = {
  id: 'evmedico1',
  cancelled: false,
  transparent: false,
  declined: false,
  appointmentId: null,
  start: { at: MONDAY_10 },
  end: { at: at('2026-10-05', '11:00') },
};

describe('Google Calendar con el worker (H12)', () => {
  it('el turno reservado aparece en el calendario de la profesional', async () => {
    const fixture = await fixtureWithCalendar();
    const google = fakeGoogleCalendar();
    const worker = buildWorker({ db, logger, now: () => SUNDAY_9, calendar: { client: google.client } });
    onTestFinished(() => worker.stop());

    const booked = await book(fixture);
    await worker.runOnce();

    expect(booked.ok).toBe(true);
    expect(google.saved).toHaveLength(1);
    expect(google.saved[0]).toMatchObject({ calendarId: CALENDAR, event: { start: MONDAY_10 } });
  });

  it('un evento ocupado del calendario bloquea ese horario', async () => {
    const fixture = await fixtureWithCalendar();
    const google = fakeGoogleCalendar({ events: [medicalAppointment] });
    const worker = buildWorker({ db, logger, now: () => SUNDAY_9, calendar: { client: google.client } });
    onTestFinished(() => worker.stop());
    await scheduleJob(db, {
      tenantId: fixture.tenantId,
      kind: 'sync_calendar_blocks',
      key: fixture.professionalId,
      payload: { professionalId: fixture.professionalId },
      runAt: SUNDAY_9,
    });

    await worker.runOnce();

    expect(await book(fixture)).toMatchObject({ ok: false, reason: 'slot_taken' });
  });

  it('sin la cuenta de servicio configurada, el worker no toma las tareas del calendario', async () => {
    const fixture = await fixtureWithCalendar();
    const worker = buildWorker({ db, logger, now: () => SUNDAY_9 });
    onTestFinished(() => worker.stop());

    await book(fixture);
    await worker.runOnce();

    const [job] = await db
      .select({ status: scheduledJobs.status })
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.tenantId, fixture.tenantId), eq(scheduledJobs.kind, 'sync_appointment_event')));
    expect(job?.status).toBe('pending');
  });
});
