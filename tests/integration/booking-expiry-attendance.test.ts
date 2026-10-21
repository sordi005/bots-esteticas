import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { deposits } from '../../src/modules/payments/schema.js';
import {
  bookAppointment,
  changeAppointmentStatus,
  confirmAttendance,
  expireReservation,
  rescheduleAppointment,
  submitTransferReceipt,
} from '../../src/modules/scheduling/booking.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, createCustomer, single, type BookableFixture } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Octubre de 2026 en Mendoza: el 4 es domingo y el 5 lunes. La seña vence a la hora de reservar.
const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const SUNDAY_9 = at('2026-10-04', '09:00');
const AFTER_DEADLINE = at('2026-10-04', '10:00');
const MONDAY_10 = at('2026-10-05', '10:00');

async function book(fixture: BookableFixture, overrides: { customerId?: string; now?: Date; start?: Date } = {}) {
  const result = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: overrides.customerId ?? fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: overrides.start ?? MONDAY_10,
    actor: 'assistant',
    now: overrides.now ?? SUNDAY_9,
  });
  if (!result.ok) throw new Error(`No se pudo reservar: ${result.reason}`);
  return result;
}

async function statusOf(appointmentId: string) {
  return single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId)))
    .status;
}

async function eventsOf(appointmentId: string) {
  return db.select().from(appointmentEvents).where(eq(appointmentEvents.appointmentId, appointmentId));
}

function expire(fixture: BookableFixture, appointmentId: string, now: Date, onChange: () => unknown = () => undefined) {
  return expireReservation(db, {
    tenantId: fixture.tenantId,
    appointmentId,
    now,
    inTransaction: (_tx, change) => {
      onChange();
      expect(change).toEqual({ appointmentId, start: MONDAY_10 });
      return Promise.resolve();
    },
  });
}

describe('expireReservation: la tarea vence la reserva provisoria (4.5)', () => {
  it('pasado el plazo, el turno vence, la seña también y queda el evento del sistema', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, deposit } = await book(fixture);
    let calls = 0;

    const result = await expire(fixture, appointmentId, AFTER_DEADLINE, () => (calls += 1));

    expect(result).toEqual({ ok: true, outcome: 'expired' });
    expect(calls).toBe(1);
    expect(await statusOf(appointmentId)).toBe('EXPIRED');
    expect(single(await db.select().from(deposits).where(eq(deposits.id, deposit?.id ?? ''))).status).toBe('expired');
    expect((await eventsOf(appointmentId)).at(-1)).toMatchObject({
      kind: 'status_change',
      fromStatus: 'PENDING_DEPOSIT',
      toStatus: 'EXPIRED',
      actor: 'system',
      reason: 'Venció el plazo para pagar la seña',
    });
  });

  it('antes del plazo no cambia nada', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await book(fixture);
    let calls = 0;

    const result = await expire(fixture, appointmentId, at('2026-10-04', '09:59'), () => (calls += 1));

    expect(result).toEqual({ ok: false, reason: 'not_due' });
    expect(calls).toBe(0);
    expect(await statusOf(appointmentId)).toBe('PENDING_DEPOSIT');
  });

  it('una seña en verificación nunca vence (4.4)', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, deposit } = await book(fixture);
    await submitTransferReceipt(db, { tenantId: fixture.tenantId, depositId: deposit?.id ?? '', mediaId: 'img-1', now: SUNDAY_9 });

    const result = await expire(fixture, appointmentId, at('2026-10-04', '20:00'));

    expect(result).toEqual({ ok: false, reason: 'not_pending', status: 'DEPOSIT_REVIEW' });
    expect(await statusOf(appointmentId)).toBe('DEPOSIT_REVIEW');
  });

  it('un turno cancelado no vence', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await book(fixture);
    await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: SUNDAY_9,
    });

    expect(await expire(fixture, appointmentId, AFTER_DEADLINE)).toEqual({
      ok: false,
      reason: 'not_pending',
      status: 'CANCELLED_BY_CUSTOMER',
    });
  });

  it('si ya lo venció una reserva que pisaba su horario, igual avisa: el aviso sale venza por donde venza', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await book(fixture);
    const other = await createCustomer(db, fixture.tenantId);
    // Otra clienta reserva el mismo horario pasado el plazo: la reserva vence la provisoria (6.6).
    await book(fixture, { customerId: other, now: at('2026-10-04', '10:05') });
    expect(await statusOf(appointmentId)).toBe('EXPIRED');
    let calls = 0;

    const result = await expire(fixture, appointmentId, at('2026-10-04', '10:06'), () => (calls += 1));

    expect(result).toEqual({ ok: true, outcome: 'already_expired' });
    expect(calls).toBe(1);
    expect((await eventsOf(appointmentId)).filter((event) => event.toStatus === 'EXPIRED')).toHaveLength(1);
  });

  it('un turno de otro negocio no se encuentra', async () => {
    const fixture = await createBookableFixture(db);
    const other = await createBookableFixture(db);
    const { appointmentId } = await book(fixture);

    expect(await expire(other, appointmentId, AFTER_DEADLINE)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('confirmAttendance: la clienta toca «Confirmo» (4.7)', () => {
  const confirm = (fixture: BookableFixture, appointmentId: string, now = at('2026-10-04', '10:30')) =>
    confirmAttendance(db, { tenantId: fixture.tenantId, appointmentId, now });

  async function confirmedAppointment() {
    const fixture = await createBookableFixture(db, { settings: { depositRequirement: 'never' } });
    const { appointmentId } = await book(fixture);
    return { fixture, appointmentId };
  }

  it('queda el evento de confirmación y el estado no cambia', async () => {
    const { fixture, appointmentId } = await confirmedAppointment();

    expect(await confirm(fixture, appointmentId)).toEqual({ ok: true, alreadyConfirmed: false });
    expect(await statusOf(appointmentId)).toBe('CONFIRMED');
    expect((await eventsOf(appointmentId)).at(-1)).toMatchObject({
      kind: 'attendance_confirmed',
      fromStatus: 'CONFIRMED',
      toStatus: 'CONFIRMED',
      actor: 'assistant',
    });
  });

  it('confirmar dos veces deja un solo evento', async () => {
    const { fixture, appointmentId } = await confirmedAppointment();
    await confirm(fixture, appointmentId);

    expect(await confirm(fixture, appointmentId)).toEqual({ ok: true, alreadyConfirmed: true });
    const confirmations = (await eventsOf(appointmentId)).filter((event) => event.kind === 'attendance_confirmed');
    expect(confirmations).toHaveLength(1);
  });

  it('después de reprogramar, la confirmación anterior ya no cuenta', async () => {
    const { fixture, appointmentId } = await confirmedAppointment();
    await confirm(fixture, appointmentId);
    await rescheduleAppointment(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      newStart: at('2026-10-06', '10:00'),
      actor: 'assistant',
      now: at('2026-10-04', '11:00'),
    });

    expect(await confirm(fixture, appointmentId, at('2026-10-05', '10:30'))).toEqual({ ok: true, alreadyConfirmed: false });
  });

  it('un turno pendiente de seña no se confirma', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await book(fixture);

    expect(await confirm(fixture, appointmentId, SUNDAY_9)).toEqual({
      ok: false,
      reason: 'not_confirmable',
      status: 'PENDING_DEPOSIT',
    });
    expect((await eventsOf(appointmentId)).some((event) => event.kind === 'attendance_confirmed')).toBe(false);
  });

  it('un turno que ya empezó no se confirma', async () => {
    const { fixture, appointmentId } = await confirmedAppointment();

    expect(await confirm(fixture, appointmentId, MONDAY_10)).toEqual({ ok: false, reason: 'already_started' });
  });

  it('un turno de otro negocio no se encuentra', async () => {
    const { appointmentId } = await confirmedAppointment();
    const other = await createBookableFixture(db);

    expect(await confirm(other, appointmentId)).toEqual({ ok: false, reason: 'not_found' });
    expect(
      (await db.select().from(appointmentEvents).where(and(eq(appointmentEvents.appointmentId, appointmentId), eq(appointmentEvents.kind, 'attendance_confirmed'))))
        .length,
    ).toBe(0);
  });
});
