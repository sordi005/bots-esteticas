import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { professionals } from '../../src/modules/catalog/schema.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { bookAppointment, changeAppointmentStatus, rescheduleAppointment } from '../../src/modules/scheduling/booking.js';
import { createDatabase } from '../../src/shared/db.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, type BookableFixture } from './support/fixtures.js';

/**
 * Todo cambio de un turno programa, en la misma transacción, la tarea que lo refleja en el Google
 * Calendar de la profesional (6.7, 8.4, D6). La tarea lee el estado actual: no lleva qué cambió.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Octubre de 2026 en Mendoza: el 4 es domingo y el 5 lunes.
const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const SUNDAY_9 = at('2026-10-04', '09:00');
const SUNDAY_11 = at('2026-10-04', '11:00');
const MONDAY_10 = at('2026-10-05', '10:00');
const MONDAY_12 = at('2026-10-05', '12:00');

async function withCalendar(fixture: BookableFixture) {
  await db
    .update(professionals)
    .set({ googleCalendarId: 'mica@gmail.com' })
    .where(and(eq(professionals.tenantId, fixture.tenantId), eq(professionals.id, fixture.professionalId)));
  return fixture;
}

async function booked(fixture: BookableFixture) {
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

function calendarJobs(tenantId: string) {
  return db
    .select({ key: scheduledJobs.key, runAt: scheduledJobs.runAt, payload: scheduledJobs.payload, status: scheduledJobs.status })
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.kind, 'sync_appointment_event')));
}

/** Como si la tarea ya hubiera corrido: el cambio siguiente la tiene que volver a programar. */
async function markDone(tenantId: string) {
  await db
    .update(scheduledJobs)
    .set({ status: 'done' })
    .where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.kind, 'sync_appointment_event')));
}

describe('la tarea que refleja un turno en el calendario (D6)', () => {
  it('al reservar con una profesional que tiene calendario, queda programada para ya', async () => {
    const fixture = await withCalendar(await createBookableFixture(db, { settings: { depositRequirement: 'never' } }));

    const appointmentId = await booked(fixture);

    expect(await calendarJobs(fixture.tenantId)).toEqual([
      { key: appointmentId, runAt: SUNDAY_9, payload: { appointmentId }, status: 'pending' },
    ]);
  });

  it('sin calendario conectado, no se programa nada', async () => {
    const fixture = await createBookableFixture(db, { settings: { depositRequirement: 'never' } });

    await booked(fixture);

    expect(await calendarJobs(fixture.tenantId)).toEqual([]);
  });

  it('un cambio de estado la vuelve a programar', async () => {
    const fixture = await withCalendar(await createBookableFixture(db, { settings: { depositRequirement: 'never' } }));
    const appointmentId = await booked(fixture);
    await markDone(fixture.tenantId);

    const changed = await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: SUNDAY_11,
    });

    expect(changed).toEqual({ ok: true });
    expect(await calendarJobs(fixture.tenantId)).toEqual([
      { key: appointmentId, runAt: SUNDAY_11, payload: { appointmentId }, status: 'pending' },
    ]);
  });

  it('reprogramar la vuelve a programar', async () => {
    const fixture = await withCalendar(await createBookableFixture(db, { settings: { depositRequirement: 'never' } }));
    const appointmentId = await booked(fixture);
    await markDone(fixture.tenantId);

    const moved = await rescheduleAppointment(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      newStart: MONDAY_12,
      actor: 'assistant',
      now: SUNDAY_11,
    });

    expect(moved).toEqual({ ok: true });
    expect(await calendarJobs(fixture.tenantId)).toEqual([
      { key: appointmentId, runAt: SUNDAY_11, payload: { appointmentId }, status: 'pending' },
    ]);
  });
});
