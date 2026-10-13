import { afterAll, describe, expect, it } from 'vitest';
import { customers } from '../../src/modules/customers/schema.js';
import { bookAppointment, changeAppointmentStatus } from '../../src/modules/scheduling/booking.js';
import {
  findCustomerAppointment,
  findCustomerAppointmentAt,
  listUpcomingCustomerAppointments,
} from '../../src/modules/scheduling/customer-appointments.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Domingo 4/10/2026 a las 9:00 en Mendoza: el lunes 5 es el primer día con lugar.
const NOW = at('2026-10-04', '09:00');

async function book(
  f: Pick<CatalogFixture, 'tenantId' | 'customerId' | 'semi' | 'mica'>,
  date: string,
  time: string,
  customerId = f.customerId,
) {
  const result = await bookAppointment(db, {
    tenantId: f.tenantId,
    customerId,
    serviceId: f.semi,
    professionalId: f.mica,
    start: at(date, time),
    actor: 'assistant',
    now: NOW,
  });
  if (!result.ok) throw new Error(`No se pudo reservar: ${result.reason}`);
  return result.appointmentId;
}

async function otherCustomer(f: CatalogFixture) {
  return single(
    await db
      .insert(customers)
      .values({ tenantId: f.tenantId, phone: '+5492614999999', name: 'Otra Clienta' })
      .returning({ id: customers.id }),
  ).id;
}

const setStatus = (
  f: CatalogFixture,
  appointmentId: string,
  to: 'DEPOSIT_REVIEW' | 'CONFIRMED' | 'CANCELLED_BY_CUSTOMER',
  actor: 'assistant' | 'owner',
) => changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId, to, actor, now: NOW });

describe('findCustomerAppointment: un turno de esta clienta', () => {
  it('trae el servicio, la profesional, el inicio, el estado y la seña', async () => {
    const f = await createCatalogFixture(db);
    const appointmentId = await book(f, '2026-10-05', '09:00');

    const appointment = await findCustomerAppointment(db, {
      tenantId: f.tenantId,
      customerId: f.customerId,
      appointmentId,
    });

    expect(appointment).toEqual({
      id: appointmentId,
      status: 'PENDING_DEPOSIT',
      start: at('2026-10-05', '09:00'),
      durationMinutes: 60,
      bufferMinutes: 10,
      serviceId: f.semi,
      serviceName: 'Esmaltado semipermanente',
      professionalId: f.mica,
      professionalName: 'Mica',
      deposit: { amountCents: 540_000, status: 'pending', expiresAt: at('2026-10-04', '10:00') },
    });
  });

  it('un turno sin seña viene con la seña en null', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    const appointmentId = await book(f, '2026-10-05', '09:00');

    const appointment = await findCustomerAppointment(db, { ...f, appointmentId });

    expect(appointment).toMatchObject({ status: 'CONFIRMED', deposit: null });
  });

  it('el turno de otra clienta del mismo negocio es null', async () => {
    const f = await createCatalogFixture(db);
    const theirs = await book(f, '2026-10-05', '09:00', await otherCustomer(f));

    expect(await findCustomerAppointment(db, { ...f, appointmentId: theirs })).toBeNull();
  });

  it('el turno de otro negocio es null, aunque se conozca el id', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    const theirs = await book(other, '2026-10-05', '09:00');

    expect(await findCustomerAppointment(db, { ...mine, appointmentId: theirs })).toBeNull();
  });

  it('un id que no existe es null', async () => {
    const f = await createCatalogFixture(db);

    expect(
      await findCustomerAppointment(db, { ...f, appointmentId: '00000000-0000-4000-8000-0000000000ff' }),
    ).toBeNull();
  });
});

describe('listUpcomingCustomerAppointments: los turnos futuros que ocupan horario', () => {
  const list = (f: CatalogFixture, now = NOW, limit = 10) =>
    listUpcomingCustomerAppointments(db, { tenantId: f.tenantId, customerId: f.customerId, now, limit });

  it('del más cercano al más lejano', async () => {
    const f = await createCatalogFixture(db);
    const later = await book(f, '2026-10-07', '10:00');
    const sooner = await book(f, '2026-10-05', '09:00');

    expect((await list(f)).map((a) => a.id)).toEqual([sooner, later]);
  });

  it('incluye los confirmados, los de seña en verificación y los de seña pendiente vigente', async () => {
    const f = await createCatalogFixture(db);
    const pending = await book(f, '2026-10-05', '09:00');
    const review = await book(f, '2026-10-06', '09:00');
    await setStatus(f, review, 'DEPOSIT_REVIEW', 'assistant');
    const confirmed = await book(f, '2026-10-07', '09:00');
    await setStatus(f, confirmed, 'CONFIRMED', 'owner');

    const listed = await list(f, at('2026-10-04', '09:30'));

    expect(listed.map((a) => [a.id, a.status])).toEqual([
      [pending, 'PENDING_DEPOSIT'],
      [review, 'DEPOSIT_REVIEW'],
      [confirmed, 'CONFIRMED'],
    ]);
  });

  it('no incluye un turno cancelado', async () => {
    const f = await createCatalogFixture(db);
    const cancelled = await book(f, '2026-10-05', '09:00');
    await setStatus(f, cancelled, 'CANCELLED_BY_CUSTOMER', 'assistant');
    const kept = await book(f, '2026-10-06', '09:00');

    expect((await list(f, at('2026-10-04', '09:30'))).map((a) => a.id)).toEqual([kept]);
  });

  it('no incluye un turno con la seña vencida, aunque la tarea todavía no lo haya vencido', async () => {
    const f = await createCatalogFixture(db);
    await book(f, '2026-10-06', '09:00');

    // La seña vencía a las 10:00 del domingo.
    expect(await list(f, at('2026-10-04', '10:30'))).toEqual([]);
  });

  it('no incluye un turno que ya empezó, aunque siga confirmado', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    await book(f, '2026-10-05', '09:00');
    const upcoming = await book(f, '2026-10-05', '15:00');

    expect((await list(f, at('2026-10-05', '09:30'))).map((a) => a.id)).toEqual([upcoming]);
  });

  it('solo los de esta clienta y de este negocio', async () => {
    const f = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    const mine = await book(f, '2026-10-05', '09:00');
    await book(f, '2026-10-06', '09:00', await otherCustomer(f));
    await book(other, '2026-10-05', '09:00');

    expect((await list(f, at('2026-10-04', '09:30'))).map((a) => a.id)).toEqual([mine]);
  });

  it('respeta el límite: devuelve los más cercanos', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    const ids: string[] = [];
    for (const day of ['05', '06', '07', '08']) ids.push(await book(f, `2026-10-${day}`, '09:00'));

    expect((await list(f, NOW, 3)).map((a) => a.id)).toEqual(ids.slice(0, 3));
  });

  it('la clienta sin turnos recibe una lista vacía', async () => {
    const f = await createCatalogFixture(db);

    expect(await list(f)).toEqual([]);
  });
});

describe('findCustomerAppointmentAt: el turno de la clienta con ese servicio, profesional e inicio', () => {
  const lookup = (f: CatalogFixture, date: string, time: string, overrides: { now?: Date; customerId?: string } = {}) =>
    findCustomerAppointmentAt(db, {
      tenantId: f.tenantId,
      customerId: overrides.customerId ?? f.customerId,
      serviceId: f.semi,
      professionalId: f.mica,
      start: at(date, time),
      now: overrides.now ?? at('2026-10-04', '09:30'),
    });

  it('lo encuentra si ocupa el horario', async () => {
    const f = await createCatalogFixture(db);
    const id = await book(f, '2026-10-05', '09:00');

    expect(await lookup(f, '2026-10-05', '09:00')).toMatchObject({ id, status: 'PENDING_DEPOSIT' });
  });

  it('no encuentra otro inicio, otra profesional ni otro servicio', async () => {
    const f = await createCatalogFixture(db);
    await book(f, '2026-10-05', '09:00');

    expect(await lookup(f, '2026-10-05', '09:15')).toBeNull();
    expect(
      await findCustomerAppointmentAt(db, {
        tenantId: f.tenantId,
        customerId: f.customerId,
        serviceId: f.semi,
        professionalId: f.sofi,
        start: at('2026-10-05', '09:00'),
        now: NOW,
      }),
    ).toBeNull();
    expect(
      await findCustomerAppointmentAt(db, {
        tenantId: f.tenantId,
        customerId: f.customerId,
        serviceId: f.sculpted,
        professionalId: f.mica,
        start: at('2026-10-05', '09:00'),
        now: NOW,
      }),
    ).toBeNull();
  });

  it('no encuentra uno cancelado ni uno con la seña vencida', async () => {
    const f = await createCatalogFixture(db);
    const cancelled = await book(f, '2026-10-05', '09:00');
    await setStatus(f, cancelled, 'CANCELLED_BY_CUSTOMER', 'assistant');
    await book(f, '2026-10-05', '15:00');

    expect(await lookup(f, '2026-10-05', '09:00')).toBeNull();
    // La seña de las 15:00 vencía a las 10:00 del domingo.
    expect(await lookup(f, '2026-10-05', '15:00', { now: at('2026-10-04', '10:30') })).toBeNull();
  });

  it('el turno de otra clienta no cuenta', async () => {
    const f = await createCatalogFixture(db);
    await book(f, '2026-10-05', '09:00', await otherCustomer(f));

    expect(await lookup(f, '2026-10-05', '09:00')).toBeNull();
  });
});
