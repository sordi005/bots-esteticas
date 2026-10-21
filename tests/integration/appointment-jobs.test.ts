import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { businessInfo } from '../../src/modules/catalog/schema.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { bookAppointment, rescheduleAppointment } from '../../src/modules/scheduling/booking.js';
import { createDatabase } from '../../src/shared/db.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, type BookableFixture } from './support/fixtures.js';

/**
 * Lo que una reserva deja programado (4.5, 4.7, H10): el vencimiento de la reserva provisoria y los
 * recordatorios, en la misma transacción. Ninguna forma de reservar se los olvida.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Octubre de 2026 en Mendoza: el 4 es domingo y el 5 lunes.
const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const SUNDAY_9 = at('2026-10-04', '09:00');
const MONDAY_10 = at('2026-10-05', '10:00');
const MONDAY_12 = at('2026-10-05', '12:00');

function book(fixture: BookableFixture, start = MONDAY_10, now = SUNDAY_9) {
  return bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start,
    actor: 'assistant',
    now,
  });
}

async function booked(fixture: BookableFixture, start?: Date, now?: Date) {
  const result = await book(fixture, start, now);
  if (!result.ok) throw new Error(`No se pudo reservar: ${result.reason}`);
  return result;
}

async function jobsOf(tenantId: string, kind: 'send_appointment_reminder' | 'expire_reservation') {
  return db
    .select({ key: scheduledJobs.key, runAt: scheduledJobs.runAt, payload: scheduledJobs.payload, status: scheduledJobs.status })
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.kind, kind)));
}

describe('al reservar se programa el vencimiento de la reserva provisoria (4.5)', () => {
  it('con seña, la tarea vence cuando vence la seña', async () => {
    const fixture = await createBookableFixture(db);

    const result = await booked(fixture);

    expect(await jobsOf(fixture.tenantId, 'expire_reservation')).toEqual([
      {
        key: result.appointmentId,
        runAt: at('2026-10-04', '10:00'),
        payload: { appointmentId: result.appointmentId },
        status: 'pending',
      },
    ]);
  });

  it('sin seña no hay nada que vencer', async () => {
    const fixture = await createBookableFixture(db, { settings: { depositRequirement: 'never' } });

    await booked(fixture);

    expect(await jobsOf(fixture.tenantId, 'expire_reservation')).toEqual([]);
  });
});

describe('al reservar se programa el recordatorio del día anterior (4.7)', () => {
  it('a la misma hora local del turno, el día anterior, con el inicio para el que se calculó', async () => {
    const fixture = await createBookableFixture(db);

    const result = await booked(fixture);

    expect(await jobsOf(fixture.tenantId, 'send_appointment_reminder')).toEqual([
      {
        key: `${result.appointmentId}:dia_anterior`,
        runAt: at('2026-10-04', '10:00'),
        payload: { appointmentId: result.appointmentId, reminder: 'day_before', appointmentStart: MONDAY_10.toISOString() },
        status: 'pending',
      },
    ]);
  });

  it('si se reservó con menos de 24 horas, no hay recordatorio', async () => {
    const fixture = await createBookableFixture(db);

    await booked(fixture, MONDAY_10, at('2026-10-04', '18:00'));

    expect(await jobsOf(fixture.tenantId, 'send_appointment_reminder')).toEqual([]);
  });

  it('sin recordatorio corto si el negocio no lo activó', async () => {
    const fixture = await createBookableFixture(db);
    await db.insert(businessInfo).values({ tenantId: fixture.tenantId, topic: 'address', content: 'San Martín 1234' });

    const result = await booked(fixture, MONDAY_12);

    expect((await jobsOf(fixture.tenantId, 'send_appointment_reminder')).map((job) => job.key)).toEqual([
      `${result.appointmentId}:dia_anterior`,
    ]);
  });
});

describe('el recordatorio corto (4.7)', () => {
  it('con el recordatorio activado y la dirección cargada, sale 2 horas antes', async () => {
    const fixture = await createBookableFixture(db, { settings: { shortReminderEnabled: true } });
    await db.insert(businessInfo).values({ tenantId: fixture.tenantId, topic: 'address', content: 'San Martín 1234' });

    const result = await booked(fixture, MONDAY_12);

    const short = (await jobsOf(fixture.tenantId, 'send_appointment_reminder')).find((job) => job.key.endsWith(':corto'));
    expect(short).toEqual({
      key: `${result.appointmentId}:corto`,
      runAt: at('2026-10-05', '10:00'),
      payload: { appointmentId: result.appointmentId, reminder: 'short', appointmentStart: MONDAY_12.toISOString() },
      status: 'pending',
    });
  });

  it('sin la dirección no se programa: la variable de la plantilla no puede ir vacía', async () => {
    const fixture = await createBookableFixture(db, { settings: { shortReminderEnabled: true } });

    await booked(fixture, MONDAY_12);

    expect((await jobsOf(fixture.tenantId, 'send_appointment_reminder')).some((job) => job.key.endsWith(':corto'))).toBe(false);
  });
});

describe('al reprogramar se vuelven a calcular los recordatorios (4.7)', () => {
  it('el recordatorio pasa al día anterior del horario nuevo, en la misma fila', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await booked(fixture);
    const tuesday10 = at('2026-10-06', '10:00');

    const result = await rescheduleAppointment(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      newStart: tuesday10,
      actor: 'assistant',
      now: at('2026-10-04', '09:30'),
    });

    expect(result).toEqual({ ok: true });
    expect(await jobsOf(fixture.tenantId, 'send_appointment_reminder')).toEqual([
      {
        key: `${appointmentId}:dia_anterior`,
        runAt: at('2026-10-05', '10:00'),
        payload: { appointmentId, reminder: 'day_before', appointmentStart: tuesday10.toISOString() },
        status: 'pending',
      },
    ]);
  });

  it('si al reprogramar falta menos de 24 horas, la tarea vieja queda para el inicio anterior y no envía nada', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await booked(fixture, at('2026-10-06', '10:00'));

    await rescheduleAppointment(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      newStart: MONDAY_10,
      actor: 'assistant',
      now: at('2026-10-04', '18:00'),
    });

    const [job] = await jobsOf(fixture.tenantId, 'send_appointment_reminder');
    // Al correr, la tarea compara este inicio con el del turno: ya no coincide (4.7).
    expect(job?.payload).toMatchObject({ appointmentStart: at('2026-10-06', '10:00').toISOString() });
  });
});
