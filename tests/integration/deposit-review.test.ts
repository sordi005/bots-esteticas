import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { deposits } from '../../src/modules/payments/schema.js';
import {
  bookAppointment,
  changeAppointmentStatus,
  reviewDeposit,
  submitTransferReceipt,
} from '../../src/modules/scheduling/booking.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, single, type BookableFixture } from './support/fixtures.js';

/**
 * Seña por transferencia (4.5, H9): el comprobante pasa el turno a verificación y la dueña
 * decide. Las dos cosas verifican el estado con el turno bloqueado y registran su evento.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

const at = (date: string, time: string) =>
  localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const SUNDAY_MORNING = at('2026-10-04', '09:00');
const SUNDAY_LATER = at('2026-10-04', '09:20');
const MONDAY_10 = at('2026-10-05', '10:00');

async function pendingBooking(fixture: BookableFixture) {
  const result = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: MONDAY_10,
    actor: 'assistant',
    now: SUNDAY_MORNING,
  });
  if (!result.ok || !result.deposit) throw new Error('La reserva de prueba no quedó pendiente de seña');
  return { appointmentId: result.appointmentId, depositId: result.deposit.id };
}

async function stateOf(appointmentId: string) {
  const appointment = single(
    await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId)),
  );
  const deposit = single(
    await db
      .select({ status: deposits.status, receiptMediaId: deposits.receiptMediaId })
      .from(deposits)
      .where(eq(deposits.appointmentId, appointmentId)),
  );
  return { appointment: appointment.status, deposit: deposit.status, receiptMediaId: deposit.receiptMediaId };
}

function receipt(fixture: BookableFixture, depositId: string, mediaId = 'media-1', now = SUNDAY_LATER) {
  return submitTransferReceipt(db, { tenantId: fixture.tenantId, depositId, mediaId, now });
}

describe('submitTransferReceipt: llegó el comprobante', () => {
  it('pasa el turno a verificación y guarda el id de la imagen en la seña', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await pendingBooking(fixture);

    const result = await receipt(fixture, depositId);

    expect(result).toEqual({ ok: true, appointmentId, alreadyRegistered: false });
    expect(await stateOf(appointmentId)).toEqual({
      appointment: 'DEPOSIT_REVIEW',
      deposit: 'in_review',
      receiptMediaId: 'media-1',
    });
    const events = await db
      .select()
      .from(appointmentEvents)
      .where(eq(appointmentEvents.appointmentId, appointmentId))
      .orderBy(appointmentEvents.occurredAt);
    expect(events.at(-1)).toMatchObject({
      fromStatus: 'PENDING_DEPOSIT',
      toStatus: 'DEPOSIT_REVIEW',
      actor: 'assistant',
      occurredAt: SUNDAY_LATER,
    });
  });

  it('se acepta pasado el plazo mientras el turno no haya vencido (4.5)', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await pendingBooking(fixture);

    const result = await receipt(fixture, depositId, 'media-1', at('2026-10-04', '18:00'));

    expect(result.ok).toBe(true);
    expect((await stateOf(appointmentId)).appointment).toBe('DEPOSIT_REVIEW');
  });

  it('la misma imagen otra vez (un reintento de la vuelta) no cambia nada y lo dice', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await pendingBooking(fixture);
    await receipt(fixture, depositId);

    const again = await receipt(fixture, depositId);

    expect(again).toEqual({ ok: true, appointmentId, alreadyRegistered: true });
  });

  it('otra imagen con la seña ya en verificación no es un comprobante nuevo', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await pendingBooking(fixture);
    await receipt(fixture, depositId);

    const other = await receipt(fixture, depositId, 'media-2');

    expect(other).toEqual({ ok: false, reason: 'not_pending', status: 'DEPOSIT_REVIEW' });
    expect((await stateOf(appointmentId)).receiptMediaId).toBe('media-1');
  });

  it('un turno cancelado conserva la seña pendiente, pero ya no acepta comprobante (4.5)', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await pendingBooking(fixture);
    await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: SUNDAY_LATER,
    });

    const result = await receipt(fixture, depositId);

    expect(result).toEqual({ ok: false, reason: 'not_pending', status: 'CANCELLED_BY_CUSTOMER' });
    expect(await stateOf(appointmentId)).toMatchObject({ deposit: 'pending', receiptMediaId: null });
  });

  it('no encuentra la seña de otro negocio (regla 1)', async () => {
    const fixture = await createBookableFixture(db);
    const other = await createBookableFixture(db);
    const { depositId } = await pendingBooking(fixture);

    const result = await receipt(other, depositId);

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('lo que se hace en el callback queda en la misma transacción: si falla, no se registra nada', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await pendingBooking(fixture);

    await expect(
      submitTransferReceipt(db, {
        tenantId: fixture.tenantId,
        depositId,
        mediaId: 'media-1',
        now: SUNDAY_LATER,
        inTransaction: () => Promise.reject(new Error('falló el aviso')),
      }),
    ).rejects.toThrow('falló el aviso');

    expect(await stateOf(appointmentId)).toMatchObject({ appointment: 'PENDING_DEPOSIT', deposit: 'pending' });
  });

  it('el callback recibe el turno registrado', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await pendingBooking(fixture);
    const seen: string[] = [];

    await submitTransferReceipt(db, {
      tenantId: fixture.tenantId,
      depositId,
      mediaId: 'media-1',
      now: SUNDAY_LATER,
      inTransaction: (_tx, registered) => {
        seen.push(registered.appointmentId);
        return Promise.resolve();
      },
    });

    expect(seen).toEqual([appointmentId]);
  });
});

describe('reviewDeposit: la dueña responde el aviso del comprobante', () => {
  async function inReview(fixture: BookableFixture) {
    const booked = await pendingBooking(fixture);
    await receipt(fixture, booked.depositId);
    return booked;
  }

  function review(fixture: BookableFixture, depositId: string, decision: 'approved' | 'rejected') {
    return reviewDeposit(db, {
      tenantId: fixture.tenantId,
      depositId,
      decision,
      actor: 'owner',
      now: at('2026-10-04', '11:00'),
    });
  }

  it('"Recibida" confirma el turno y aprueba la seña', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await inReview(fixture);

    const result = await review(fixture, depositId, 'approved');

    expect(result).toEqual({ ok: true, appointmentId, status: 'CONFIRMED' });
    expect(await stateOf(appointmentId)).toMatchObject({ appointment: 'CONFIRMED', deposit: 'approved' });
  });

  it('"No llegó" rechaza el turno y la seña, y libera el horario', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await inReview(fixture);

    const result = await review(fixture, depositId, 'rejected');

    expect(result).toEqual({ ok: true, appointmentId, status: 'DEPOSIT_REJECTED' });
    expect(await stateOf(appointmentId)).toMatchObject({ appointment: 'DEPOSIT_REJECTED', deposit: 'rejected' });

    const again = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: fixture.customerId,
      serviceId: fixture.serviceId,
      professionalId: fixture.professionalId,
      start: MONDAY_10,
      actor: 'assistant',
      now: at('2026-10-04', '11:30'),
    });
    expect(again.ok).toBe(true);
  });

  it('una seña ya respondida no cambia: devuelve el estado actual', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await inReview(fixture);
    await review(fixture, depositId, 'approved');

    const second = await review(fixture, depositId, 'rejected');

    expect(second).toEqual({ ok: false, reason: 'not_in_review', appointmentId, status: 'CONFIRMED' });
    expect((await stateOf(appointmentId)).deposit).toBe('approved');
  });

  it('si la clienta canceló mientras tanto, no la confirma', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await inReview(fixture);
    await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: at('2026-10-04', '10:00'),
    });

    const result = await review(fixture, depositId, 'approved');

    expect(result).toEqual({
      ok: false,
      reason: 'not_in_review',
      appointmentId,
      status: 'CANCELLED_BY_CUSTOMER',
    });
  });

  it('el asistente nunca confirma una transferencia (4.4)', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await inReview(fixture);

    const result = await reviewDeposit(db, {
      tenantId: fixture.tenantId,
      depositId,
      decision: 'approved',
      actor: 'assistant',
      now: at('2026-10-04', '11:00'),
    });

    expect(result).toEqual({ ok: false, reason: 'not_allowed' });
    expect((await stateOf(appointmentId)).appointment).toBe('DEPOSIT_REVIEW');
  });

  it('no encuentra la seña de otro negocio (regla 1)', async () => {
    const fixture = await createBookableFixture(db);
    const other = await createBookableFixture(db);
    const { depositId } = await inReview(fixture);

    expect(await review(other, depositId, 'approved')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('si el callback falla, la decisión no queda registrada', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await inReview(fixture);

    await expect(
      reviewDeposit(db, {
        tenantId: fixture.tenantId,
        depositId,
        decision: 'approved',
        actor: 'owner',
        now: at('2026-10-04', '11:00'),
        inTransaction: () => Promise.reject(new Error('falló el aviso')),
      }),
    ).rejects.toThrow('falló el aviso');

    expect((await stateOf(appointmentId)).appointment).toBe('DEPOSIT_REVIEW');
  });
});
