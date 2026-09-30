import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { customers } from '../../src/modules/customers/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import {
  bookAppointment,
  changeAppointmentStatus,
  countReschedules,
  rescheduleAppointment,
} from '../../src/modules/scheduling/booking.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import {
  createBookableFixture,
  createCustomer,
  single,
  type BookableFixture,
} from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Octubre de 2026 en Mendoza: el 4 es domingo y el 5 lunes.
const at = (date: string, time: string) =>
  localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const SUNDAY_MORNING = at('2026-10-04', '09:00');
const MONDAY_10 = at('2026-10-05', '10:00');

function booking(fixture: BookableFixture, overrides: Partial<Parameters<typeof bookAppointment>[1]> = {}) {
  return bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: MONDAY_10,
    actor: 'assistant',
    now: SUNDAY_MORNING,
    ...overrides,
  });
}

async function appointmentRow(id: string) {
  return single(await db.select().from(appointments).where(eq(appointments.id, id)));
}

async function eventsOf(id: string) {
  return db
    .select()
    .from(appointmentEvents)
    .where(eq(appointmentEvents.appointmentId, id))
    .orderBy(appointmentEvents.occurredAt);
}

function expectBooked<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  return result as Extract<T, { ok: true }>;
}

describe('bookAppointment: reservar un turno', () => {
  it('con seña, el turno queda pendiente con la seña calculada y su vencimiento', async () => {
    const fixture = await createBookableFixture(db);

    const result = expectBooked(await booking(fixture));

    expect(result.status).toBe('PENDING_DEPOSIT');
    expect(result.deposit).toMatchObject({
      amountCents: 540_000,
      expiresAt: at('2026-10-04', '10:00'),
    });

    const appointment = await appointmentRow(result.appointmentId);
    expect(appointment).toMatchObject({
      status: 'PENDING_DEPOSIT',
      timeRange: { start: MONDAY_10, end: at('2026-10-05', '11:10') },
      durationMinutes: 60,
      bufferMinutes: 10,
      priceCents: 1_800_000,
      cashPriceCents: 1_600_000,
      priceType: 'fixed',
      origin: 'assistant',
    });

    expect(await eventsOf(result.appointmentId)).toMatchObject([
      { kind: 'status_change', fromStatus: null, toStatus: 'PENDING_DEPOSIT', actor: 'assistant', occurredAt: SUNDAY_MORNING },
    ]);

    const deposit = single(
      await db.select().from(deposits).where(eq(deposits.appointmentId, result.appointmentId)),
    );
    expect(deposit).toMatchObject({ amountCents: 540_000, status: 'pending', method: null });
  });

  it('sin seña, el turno queda confirmado directo', async () => {
    const fixture = await createBookableFixture(db, { settings: { depositRequirement: 'never' } });

    const result = expectBooked(await booking(fixture));

    expect(result.status).toBe('CONFIRMED');
    expect(result.deposit).toBeNull();
    expect(await db.select().from(deposits).where(eq(deposits.appointmentId, result.appointmentId))).toEqual([]);
  });

  it('usa la duración propia de la profesional para ocupar su horario', async () => {
    const fixture = await createBookableFixture(db, { durationOverrideMinutes: 75 });

    const result = expectBooked(await booking(fixture));

    expect(await appointmentRow(result.appointmentId)).toMatchObject({
      durationMinutes: 75,
      timeRange: { start: MONDAY_10, end: at('2026-10-05', '11:25') },
    });
  });

  it.each([
    ['fuera del horario de trabajo', { start: at('2026-10-05', '13:30') }],
    ['en un minuto que no está en la grilla', { start: at('2026-10-05', '10:05') }],
    ['sin la anticipación mínima', { now: at('2026-10-05', '09:40') }],
    ['en un día sin horario', { start: at('2026-10-04', '10:00'), now: at('2026-10-03', '09:00') }],
  ])('no reserva %s', async (_case, overrides) => {
    const fixture = await createBookableFixture(db);

    expect(await booking(fixture, overrides)).toEqual({ ok: false, reason: 'slot_unavailable' });
  });

  it('no reserva un horario que se superpone con otro turno', async () => {
    const fixture = await createBookableFixture(db);
    expectBooked(await booking(fixture));
    const otherCustomer = await createCustomer(db, fixture.tenantId);

    expect(
      await booking(fixture, { customerId: otherCustomer, start: at('2026-10-05', '10:30') }),
    ).toEqual({ ok: false, reason: 'slot_taken' });
  });

  it.each([
    ['requiere consulta previa', { requiresConsultation: true }],
    ['está oculto', { visible: false }],
  ])('el asistente no reserva un servicio que %s: deriva', async (_case, service) => {
    const fixture = await createBookableFixture(db, { service });

    expect(await booking(fixture)).toEqual({ ok: false, reason: 'service_not_bookable' });
    expectBooked(await booking(fixture, { actor: 'owner' }));
  });

  it('no reserva con una profesional que no hace el servicio', async () => {
    const fixture = await createBookableFixture(db);
    const other = await createBookableFixture(db);

    expect(await booking(fixture, { professionalId: other.professionalId })).toEqual({
      ok: false,
      reason: 'professional_unavailable',
    });
  });

  it.each([
    ['el servicio', 'serviceId'],
    ['la clienta', 'customerId'],
  ] as const)('no reserva con %s de otro negocio (regla 1)', async (_case, field) => {
    const fixture = await createBookableFixture(db);
    const other = await createBookableFixture(db);

    expect(await booking(fixture, { [field]: other[field] })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('cinco reservas simultáneas del mismo horario: gana una sola (sección 11.2)', async () => {
    const fixture = await createBookableFixture(db);
    const contenders = await Promise.all(
      Array.from({ length: 5 }, () => createCustomer(db, fixture.tenantId)),
    );

    const results = await Promise.all(
      contenders.map((customerId) => booking(fixture, { customerId })),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual(
      Array.from({ length: 4 }, () => ({ ok: false, reason: 'slot_taken' })),
    );
    const booked = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.tenantId, fixture.tenantId));
    expect(booked).toHaveLength(1);
  });

  it('una reserva provisoria vencida libera el horario: se la vence al reservar encima', async () => {
    const fixture = await createBookableFixture(db);
    const first = expectBooked(await booking(fixture));
    const otherCustomer = await createCustomer(db, fixture.tenantId);

    // La seña vencía a las 10:00 y nadie pagó. A las 10:30 otra clienta pide el mismo horario.
    const second = expectBooked(
      await booking(fixture, { customerId: otherCustomer, now: at('2026-10-04', '10:30') }),
    );

    expect(second.status).toBe('PENDING_DEPOSIT');
    expect((await appointmentRow(first.appointmentId)).status).toBe('EXPIRED');
    expect((await eventsOf(first.appointmentId)).at(-1)).toMatchObject({
      fromStatus: 'PENDING_DEPOSIT',
      toStatus: 'EXPIRED',
      actor: 'system',
    });
    const expiredDeposit = single(
      await db.select().from(deposits).where(eq(deposits.appointmentId, first.appointmentId)),
    );
    expect(expiredDeposit.status).toBe('expired');
  });
});

describe('changeAppointmentStatus: cambios de estado con auditoría (regla 4)', () => {
  it('cambia el estado y registra el evento', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = expectBooked(await booking(fixture));

    const result = await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      reason: 'La clienta avisó que no puede ir',
      now: at('2026-10-04', '09:30'),
    });

    expect(result).toEqual({ ok: true });
    expect((await appointmentRow(appointmentId)).status).toBe('CANCELLED_BY_CUSTOMER');
    expect((await eventsOf(appointmentId)).at(-1)).toMatchObject({
      fromStatus: 'PENDING_DEPOSIT',
      toStatus: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      reason: 'La clienta avisó que no puede ir',
      occurredAt: at('2026-10-04', '09:30'),
    });
  });

  it('rechaza una transición no permitida sin tocar nada', async () => {
    const fixture = await createBookableFixture(db, { settings: { depositRequirement: 'never' } });
    const { appointmentId } = expectBooked(await booking(fixture));

    const result = await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'NO_SHOW',
      actor: 'assistant',
      now: SUNDAY_MORNING,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_transition' });
    expect((await appointmentRow(appointmentId)).status).toBe('CONFIRMED');
    expect(await eventsOf(appointmentId)).toHaveLength(1);
  });

  it('marcar ausente suma una ausencia a la clienta (para la regla de seña)', async () => {
    const fixture = await createBookableFixture(db, { settings: { depositRequirement: 'never' } });
    const { appointmentId } = expectBooked(await booking(fixture));

    await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'NO_SHOW',
      actor: 'owner',
      now: at('2026-10-05', '21:00'),
    });

    const customer = single(
      await db
        .select({ noShowCount: customers.noShowCount })
        .from(customers)
        .where(eq(customers.id, fixture.customerId)),
    );
    expect(customer.noShowCount).toBe(1);
  });

  it('un turno cancelado libera el horario', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = expectBooked(await booking(fixture));
    await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: SUNDAY_MORNING,
    });
    const otherCustomer = await createCustomer(db, fixture.tenantId);

    expectBooked(await booking(fixture, { customerId: otherCustomer }));
  });

  it('no encuentra un turno de otro negocio (regla 1)', async () => {
    const fixture = await createBookableFixture(db);
    const other = await createBookableFixture(db);
    const { appointmentId } = expectBooked(await booking(other));

    expect(
      await changeAppointmentStatus(db, {
        tenantId: fixture.tenantId,
        appointmentId,
        to: 'CANCELLED_BY_BUSINESS',
        actor: 'owner',
        now: SUNDAY_MORNING,
      }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('rescheduleAppointment: reprogramar', () => {
  async function reschedule(fixture: BookableFixture, appointmentId: string, newStart: Date) {
    return rescheduleAppointment(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      newStart,
      actor: 'assistant',
      now: SUNDAY_MORNING,
    });
  }

  it('mueve el turno, conserva el estado y registra el horario anterior', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = expectBooked(await booking(fixture));

    expect(await reschedule(fixture, appointmentId, at('2026-10-05', '16:00'))).toEqual({ ok: true });

    expect(await appointmentRow(appointmentId)).toMatchObject({
      status: 'PENDING_DEPOSIT',
      timeRange: { start: at('2026-10-05', '16:00'), end: at('2026-10-05', '17:10') },
    });
    expect((await eventsOf(appointmentId)).at(-1)).toMatchObject({
      kind: 'rescheduled',
      fromStatus: 'PENDING_DEPOSIT',
      toStatus: 'PENDING_DEPOSIT',
      previousTimeRange: { start: MONDAY_10, end: at('2026-10-05', '11:10') },
    });
  });

  it('se puede correr un rato aunque el horario nuevo pise el suyo anterior', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = expectBooked(await booking(fixture));

    expect(await reschedule(fixture, appointmentId, at('2026-10-05', '10:30'))).toEqual({ ok: true });
  });

  it('no se mueve a un horario ocupado por otro turno', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = expectBooked(await booking(fixture));
    const otherCustomer = await createCustomer(db, fixture.tenantId);
    expectBooked(await booking(fixture, { customerId: otherCustomer, start: at('2026-10-05', '16:00') }));

    expect(await reschedule(fixture, appointmentId, at('2026-10-05', '16:30'))).toEqual({
      ok: false,
      reason: 'slot_taken',
    });
  });

  it('no se mueve fuera del horario de trabajo', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = expectBooked(await booking(fixture));

    expect(await reschedule(fixture, appointmentId, at('2026-10-05', '14:00'))).toEqual({
      ok: false,
      reason: 'slot_unavailable',
    });
  });

  it('no se reprograma un turno cancelado', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = expectBooked(await booking(fixture));
    await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: SUNDAY_MORNING,
    });

    expect(await reschedule(fixture, appointmentId, at('2026-10-05', '16:00'))).toEqual({
      ok: false,
      reason: 'not_reschedulable',
    });
  });

  it('cuenta las reprogramaciones para la política de seña', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = expectBooked(await booking(fixture));
    await reschedule(fixture, appointmentId, at('2026-10-05', '16:00'));
    await reschedule(fixture, appointmentId, at('2026-10-05', '17:00'));

    expect(await countReschedules(db, { tenantId: fixture.tenantId, appointmentId })).toBe(2);
    expect(
      await countReschedules(db, { tenantId: (await createBookableFixture(db)).tenantId, appointmentId }),
    ).toBe(0);
  });
});
