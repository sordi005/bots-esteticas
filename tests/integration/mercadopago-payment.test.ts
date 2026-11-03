import { randomBytes, randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { MercadoPagoPayment } from '../../src/modules/mercadopago/client.js';
import { processMercadoPagoPayment } from '../../src/modules/mercadopago/payment-processing.js';
import { notifications } from '../../src/modules/notifications/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { handoffs } from '../../src/modules/conversation/schema.js';
import { bookAppointment, changeAppointmentStatus, expireReservation } from '../../src/modules/scheduling/booking.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, single, type BookableFixture } from './support/fixtures.js';
import { connectMercadoPago, fakeMercadoPago, MERCADOPAGO_ACCESS_TOKEN } from './support/mercadopago.js';
import { noticeBody } from './support/notices.js';

/**
 * Procesar un pago de Mercado Pago (4.5, 8.3): la tarea consulta el pago a la API con el token del
 * negocio (nunca confía en el aviso) y, si es la seña aprobada de un turno pendiente, lo confirma.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = createLogger({ logLevel: 'silent' });
const credentialsKey = randomBytes(32);

afterAll(() => database.close());

const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const BOOKED_AT = at('2026-10-04', '09:00');
const PAID_AT = at('2026-10-04', '09:20');

async function bookedWithMercadoPago(options: { connected?: boolean } = {}) {
  const fixture = await createBookableFixture(db, { settings: { depositPaymentOptions: 'mercadopago' } });
  if (options.connected ?? true) await connectMercadoPago(db, credentialsKey, fixture.tenantId);
  const booked = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: at('2026-10-05', '10:00'),
    actor: 'assistant',
    now: BOOKED_AT,
  });
  if (!booked.ok || !booked.deposit) throw new Error('La reserva de prueba no quedó pendiente de seña');
  const deposit = single(await db.select().from(deposits).where(eq(deposits.id, booked.deposit.id)));
  return { fixture, appointmentId: booked.appointmentId, deposit };
}

const approved = (externalReference: string, amountCents: number, overrides: Partial<MercadoPagoPayment> = {}): MercadoPagoPayment => ({
  // Los ids de pago son únicos en toda la base, como en Mercado Pago.
  id: String(randomInt(1, 2 ** 47)),
  status: 'approved',
  externalReference,
  amountCents,
  currency: 'ARS',
  ...overrides,
});

function process(fixture: BookableFixture, payments: MercadoPagoPayment[], paymentId = payments[0]?.id ?? '999') {
  const mercadoPago = fakeMercadoPago({ payments });
  const result = processMercadoPagoPayment(
    { db, logger, client: mercadoPago.client, credentialsKey, now: () => PAID_AT },
    { tenantId: fixture.tenantId, paymentId },
  );
  return { result, consulted: mercadoPago.consulted };
}

const statusOf = async (appointmentId: string) =>
  single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId))).status;

const noticesOf = (tenantId: string) => db.select().from(notifications).where(eq(notifications.tenantId, tenantId));

describe('processMercadoPagoPayment: la seña aprobada (D7)', () => {
  it('consulta el pago con el token del negocio, confirma el turno y la seña, y le avisa a la clienta', async () => {
    const { fixture, appointmentId, deposit } = await bookedWithMercadoPago();

    const payment = approved(deposit.id, deposit.amountCents);
    const { result, consulted } = process(fixture, [payment]);

    expect(await result).toBe('confirmed');
    expect(consulted).toEqual([{ accessToken: MERCADOPAGO_ACCESS_TOKEN, paymentId: payment.id }]);
    expect(await statusOf(appointmentId)).toBe('CONFIRMED');
    expect(single(await db.select().from(deposits).where(eq(deposits.id, deposit.id)))).toMatchObject({
      status: 'approved',
      mercadopagoPaymentId: payment.id,
    });
    expect(
      await db.select().from(appointmentEvents).where(eq(appointmentEvents.appointmentId, appointmentId)),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ fromStatus: 'PENDING_DEPOSIT', toStatus: 'CONFIRMED', actor: 'system' })]),
    );
    const notices = await noticesOf(fixture.tenantId);
    // Sin aviso a la dueña: el cobro lo ve en su cuenta de Mercado Pago.
    expect(notices.map((notice) => [notice.recipient, notice.kind])).toEqual([['customer', 'deposit_confirmed']]);
    expect(noticeBody(notices[0]?.message)).toMatch(/^¡Seña recibida! Tu turno de .* quedó confirmado/);
    expect(notices[0]?.template).toMatchObject({ name: 'sena_confirmada' });
  });

  it('un monto mayor que la seña también confirma', async () => {
    const { fixture, appointmentId, deposit } = await bookedWithMercadoPago();

    expect(await process(fixture, [approved(deposit.id, deposit.amountCents + 100)]).result).toBe('confirmed');
    expect(await statusOf(appointmentId)).toBe('CONFIRMED');
  });

  it('el mismo pago otra vez (Mercado Pago avisa más de una vez) no cambia nada ni avisa de nuevo', async () => {
    const { fixture, deposit } = await bookedWithMercadoPago();
    const payments = [approved(deposit.id, deposit.amountCents)];
    await process(fixture, payments).result;

    expect(await process(fixture, payments).result).toBe('already_processed');
    expect(await noticesOf(fixture.tenantId)).toHaveLength(1);
  });

  it.each([['rejected'], ['in_process'], ['cancelled']])('un pago %s no cambia nada', async (status) => {
    const { fixture, appointmentId, deposit } = await bookedWithMercadoPago();

    expect(await process(fixture, [approved(deposit.id, deposit.amountCents, { status })]).result).toBe('not_approved');
    expect(await statusOf(appointmentId)).toBe('PENDING_DEPOSIT');
    expect(await noticesOf(fixture.tenantId)).toEqual([]);
  });

  it('un pago con la referencia de una seña de otro negocio no toca esa seña (regla 1)', async () => {
    const other = await bookedWithMercadoPago();
    const { fixture } = await bookedWithMercadoPago();

    expect(await process(fixture, [approved(other.deposit.id, other.deposit.amountCents)]).result).toBe('unknown_deposit');
    expect(await statusOf(other.appointmentId)).toBe('PENDING_DEPOSIT');
  });

  it.each([
    ['sin referencia', null],
    ['con una referencia que no es una seña', 'pedido-123'],
  ])('un pago %s no toca nada', async (_case, externalReference) => {
    const { fixture, appointmentId } = await bookedWithMercadoPago();

    expect(await process(fixture, [approved('x', 540_000, { externalReference })]).result).toBe('unknown_deposit');
    expect(await statusOf(appointmentId)).toBe('PENDING_DEPOSIT');
  });

  it('un negocio que ya no tiene Mercado Pago conectado no consulta nada (regla 7)', async () => {
    const { fixture, deposit } = await bookedWithMercadoPago({ connected: false });

    const { result, consulted } = process(fixture, [approved(deposit.id, deposit.amountCents)]);

    expect(await result).toBe('not_connected');
    expect(consulted).toEqual([]);
  });

  it('si Mercado Pago no responde, falla para que la cola reintente', async () => {
    const { fixture } = await bookedWithMercadoPago();

    await expect(process(fixture, [], '999').result).rejects.toThrow();
  });
});

describe('processMercadoPagoPayment: un pago que no se puede aplicar (D8)', () => {
  const handoffsOf = (tenantId: string) => db.select().from(handoffs).where(eq(handoffs.tenantId, tenantId));
  const customerNotices = async (tenantId: string) =>
    (await noticesOf(tenantId)).filter((notice) => notice.recipient === 'customer');

  async function expectDerived(tenantId: string, summary: string | RegExp, customerText: string) {
    expect(await handoffsOf(tenantId)).toMatchObject([{ reason: 'payment_issue', status: 'open', summary }]);
    const notices = await customerNotices(tenantId);
    expect(notices.map((notice) => notice.kind)).toEqual(['payment_not_applied']);
    expect(noticeBody(notices[0]?.message)).toBe(customerText);
  }

  it('con el turno vencido no lo toca: guarda el pago en la seña y deriva con «pago»', async () => {
    const { fixture, appointmentId, deposit } = await bookedWithMercadoPago();
    await expireReservation(db, { tenantId: fixture.tenantId, appointmentId, now: at('2026-10-04', '10:00') });
    const payment = approved(deposit.id, deposit.amountCents);

    expect(await process(fixture, [payment]).result).toBe('not_applied');

    expect(await statusOf(appointmentId)).toBe('EXPIRED');
    expect(single(await db.select().from(deposits).where(eq(deposits.id, deposit.id))).mercadopagoPaymentId).toBe(payment.id);
    await expectDerived(
      fixture.tenantId,
      'Pagó la seña por Mercado Pago, pero el turno ya estaba vencido. Si corresponde, la devolución la hacés vos.',
      'Nos llegó tu pago, pero el turno ya se había liberado. Una persona del equipo te escribe por acá.',
    );
    // La dueña recibe el aviso de la derivación, con el resumen.
    expect((await noticesOf(fixture.tenantId)).some((notice) => notice.recipient === 'owner' && notice.kind === 'handoff')).toBe(true);
  });

  it('con el turno cancelado, lo mismo', async () => {
    const { fixture, appointmentId, deposit } = await bookedWithMercadoPago();
    await changeAppointmentStatus(db, { tenantId: fixture.tenantId, appointmentId, to: 'CANCELLED_BY_CUSTOMER', actor: 'assistant', now: BOOKED_AT });

    expect(await process(fixture, [approved(deposit.id, deposit.amountCents)]).result).toBe('not_applied');

    expect(await statusOf(appointmentId)).toBe('CANCELLED_BY_CUSTOMER');
    await expectDerived(
      fixture.tenantId,
      'Pagó la seña por Mercado Pago, pero el turno ya estaba cancelado. Si corresponde, la devolución la hacés vos.',
      'Nos llegó tu pago, pero el turno ya se había liberado. Una persona del equipo te escribe por acá.',
    );
  });

  it('con el turno ya confirmado por otro pago, no lo toca y deriva', async () => {
    const { fixture, appointmentId, deposit } = await bookedWithMercadoPago();
    const first = approved(deposit.id, deposit.amountCents);
    await process(fixture, [first]).result;

    expect(await process(fixture, [approved(deposit.id, deposit.amountCents)]).result).toBe('not_applied');

    expect(await statusOf(appointmentId)).toBe('CONFIRMED');
    expect(single(await db.select().from(deposits).where(eq(deposits.id, deposit.id))).mercadopagoPaymentId).toBe(first.id);
    expect(await handoffsOf(fixture.tenantId)).toMatchObject([
      {
        reason: 'payment_issue',
        summary: 'Pagó la seña dos veces por Mercado Pago: el turno ya estaba confirmado. Si corresponde, la devolución la hacés vos.',
      },
    ]);
    const notices = await customerNotices(fixture.tenantId);
    expect(notices.map((notice) => notice.kind)).toEqual(['deposit_confirmed', 'payment_not_applied']);
    expect(noticeBody(notices[1]?.message)).toBe(
      'Nos llegó otro pago de la seña, pero tu turno ya estaba confirmado. Una persona del equipo te escribe por acá.',
    );
  });

  it.each([
    ['un monto menor que la seña', { amountCents: 100_000 }, /^Pagó por Mercado Pago \$1\.000, que no cubre la seña de \$5\.400: el turno sigue pendiente de seña\. Revisalo vos\.$/],
    ['otra moneda', { currency: 'USD' }, /^Pagó por Mercado Pago en otra moneda \(USD\): el turno sigue pendiente de seña\. Revisalo vos\.$/],
  ])('con %s, el turno sigue pendiente y deriva', async (_case, overrides, summary) => {
    const { fixture, appointmentId, deposit } = await bookedWithMercadoPago();

    expect(await process(fixture, [approved(deposit.id, deposit.amountCents, overrides)]).result).toBe('not_applied');

    expect(await statusOf(appointmentId)).toBe('PENDING_DEPOSIT');
    await expectDerived(
      fixture.tenantId,
      summary,
      'Nos llegó tu pago, pero no coincide con la seña. Una persona del equipo te escribe por acá.',
    );
  });

  it('el mismo pago otra vez no deriva ni avisa de nuevo', async () => {
    const { fixture, appointmentId, deposit } = await bookedWithMercadoPago();
    await expireReservation(db, { tenantId: fixture.tenantId, appointmentId, now: at('2026-10-04', '10:00') });
    const payments = [approved(deposit.id, deposit.amountCents)];
    await process(fixture, payments).result;

    expect(await process(fixture, payments).result).toBe('already_processed');

    expect(await handoffsOf(fixture.tenantId)).toHaveLength(1);
    expect(await customerNotices(fixture.tenantId)).toHaveLength(1);
  });

  it('otro pago tardío de la misma seña tampoco: la clienta recibe el texto una sola vez por seña', async () => {
    const { fixture, appointmentId, deposit } = await bookedWithMercadoPago();
    await expireReservation(db, { tenantId: fixture.tenantId, appointmentId, now: at('2026-10-04', '10:00') });
    await process(fixture, [approved(deposit.id, deposit.amountCents)]).result;

    expect(await process(fixture, [approved(deposit.id, deposit.amountCents)]).result).toBe('not_applied');

    expect(await customerNotices(fixture.tenantId)).toHaveLength(1);
  });
});
