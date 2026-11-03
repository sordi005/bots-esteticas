import { randomBytes, randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { MercadoPagoPayment } from '../../src/modules/mercadopago/client.js';
import { runReservationExpiry } from '../../src/modules/notifications/reservation-expiry.js';
import { notifications } from '../../src/modules/notifications/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { bookAppointment } from '../../src/modules/scheduling/booking.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, single } from './support/fixtures.js';
import { connectMercadoPago, fakeMercadoPago, MERCADOPAGO_ACCESS_TOKEN } from './support/mercadopago.js';

/**
 * Por si un webhook se pierde (4.5, decisión 42): antes de vencer una seña de Mercado Pago, la tarea
 * de vencimiento busca un pago con su `external_reference`. Si hay uno aprobado, se procesa como si
 * hubiera llegado el webhook, en vez de vencer el turno.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = createLogger({ logLevel: 'silent' });
const credentialsKey = randomBytes(32);

afterAll(() => database.close());

const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const BOOKED_AT = at('2026-10-04', '09:00');
const DUE = at('2026-10-04', '10:00');

async function booked(method: 'mercadopago' | 'transfer' = 'mercadopago') {
  const fixture = await createBookableFixture(db, { settings: { depositPaymentOptions: method } });
  await connectMercadoPago(db, credentialsKey, fixture.tenantId);
  const result = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: at('2026-10-05', '10:00'),
    actor: 'assistant',
    now: BOOKED_AT,
  });
  if (!result.ok || !result.deposit) throw new Error('La reserva de prueba no quedó pendiente de seña');
  const deposit = single(await db.select().from(deposits).where(eq(deposits.id, result.deposit.id)));
  return { fixture, appointmentId: result.appointmentId, deposit };
}

const payment = (externalReference: string, amountCents: number, status = 'approved'): MercadoPagoPayment => ({
  id: String(randomInt(1, 2 ** 47)),
  status,
  externalReference,
  amountCents,
  currency: 'ARS',
});

function expire(input: { tenantId: string; appointmentId: string }, mercadoPago: ReturnType<typeof fakeMercadoPago>, now = DUE) {
  return runReservationExpiry(
    { db, logger, now: () => now, mercadoPago: { client: mercadoPago.client, credentialsKey } },
    input,
  );
}

const statusOf = async (appointmentId: string) =>
  single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId))).status;

const noticeKinds = async (appointmentId: string) =>
  (await db.select().from(notifications).where(eq(notifications.appointmentId, appointmentId))).map((notice) => notice.kind);

describe('expire_reservation con una seña de Mercado Pago (D9)', () => {
  it('si encuentra el pago aprobado, confirma el turno en vez de vencerlo', async () => {
    const { fixture, appointmentId, deposit } = await booked();
    const mercadoPago = fakeMercadoPago({ payments: [payment(deposit.id, deposit.amountCents)] });

    expect(await expire({ tenantId: fixture.tenantId, appointmentId }, mercadoPago)).toBe('paid');

    expect(mercadoPago.consulted).toEqual([{ accessToken: MERCADOPAGO_ACCESS_TOKEN, externalReference: deposit.id }]);
    expect(await statusOf(appointmentId)).toBe('CONFIRMED');
    expect(await noticeKinds(appointmentId)).toEqual(['deposit_confirmed']);
  });

  it('sin pagos, o solo con pagos rechazados, vence como siempre', async () => {
    const { fixture, appointmentId, deposit } = await booked();
    const mercadoPago = fakeMercadoPago({ payments: [payment(deposit.id, deposit.amountCents, 'rejected')] });

    expect(await expire({ tenantId: fixture.tenantId, appointmentId }, mercadoPago)).toBe('expired');

    expect(await statusOf(appointmentId)).toBe('EXPIRED');
    expect(await noticeKinds(appointmentId)).toEqual(['reservation_expired']);
  });

  it('si Mercado Pago no responde, vence igual: si el pago llegó, su aviso entra después', async () => {
    const { fixture, appointmentId } = await booked();

    expect(await expire({ tenantId: fixture.tenantId, appointmentId }, fakeMercadoPago({ fail: new TypeError('fetch failed') }))).toBe(
      'expired',
    );
    expect(await statusOf(appointmentId)).toBe('EXPIRED');
  });

  it('antes del plazo no busca nada', async () => {
    const { fixture, appointmentId } = await booked();
    const mercadoPago = fakeMercadoPago();

    expect(await expire({ tenantId: fixture.tenantId, appointmentId }, mercadoPago, at('2026-10-04', '09:30'))).toBe('not_due');
    expect(mercadoPago.consulted).toEqual([]);
  });

  it('una seña por transferencia no se busca en Mercado Pago', async () => {
    const { fixture, appointmentId } = await booked('transfer');
    const mercadoPago = fakeMercadoPago();

    expect(await expire({ tenantId: fixture.tenantId, appointmentId }, mercadoPago)).toBe('expired');
    expect(mercadoPago.consulted).toEqual([]);
  });
});
