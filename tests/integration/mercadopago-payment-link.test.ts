import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { MercadoPagoApiError, type MercadoPagoClient, type PreferenceInput } from '../../src/modules/mercadopago/client.js';
import { ensurePaymentLink } from '../../src/modules/mercadopago/payment-link.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { bookAppointment } from '../../src/modules/scheduling/booking.js';
import { saveCredential } from '../../src/modules/tenants/credentials.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, single, type BookableFixture } from './support/fixtures.js';

/**
 * El link de pago de la seña (4.5, 8.3): la preferencia se crea con el token del negocio una sola vez
 * por seña, y el link queda guardado para volver a darlo.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = createLogger({ logLevel: 'silent' });
const credentialsKey = randomBytes(32);
const PUBLIC_BASE_URL = 'https://ejemplo.ngrok-free.dev';

afterAll(() => database.close());

const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const BOOKED_AT = at('2026-10-04', '09:00');

function fakeClient(fail?: Error) {
  const created: { accessToken: string; preference: PreferenceInput }[] = [];
  const unused = () => Promise.reject(new Error('No se usa'));
  const client: MercadoPagoClient = {
    exchangeCode: unused,
    refreshToken: unused,
    createPreference: (input) => {
      if (fail) return Promise.reject(fail);
      created.push(input);
      return Promise.resolve({
        preferenceId: `pref-${String(created.length)}`,
        paymentUrl: `https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-${String(created.length)}`,
      });
    },
    getPayment: unused,
    searchPayments: unused,
  };
  return { client, created };
}

async function connectMercadoPago(tenantId: string) {
  await saveCredential(db, credentialsKey, {
    tenantId,
    kind: 'mercadopago',
    value: { accessToken: 'APP_USR-del-negocio', refreshToken: 'TG-r', userId: '1', liveMode: false },
  });
}

async function book(fixture: BookableFixture) {
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
  return { appointmentId: booked.appointmentId, depositId: booked.deposit.id };
}

const ensure = (client: MercadoPagoClient, tenantId: string, appointmentId: string) =>
  ensurePaymentLink(
    { db, logger, client, credentialsKey, publicBaseUrl: PUBLIC_BASE_URL },
    { tenantId, appointmentId, title: 'Seña: Esmaltado semipermanente', now: BOOKED_AT },
  );

const depositOf = async (depositId: string) => single(await db.select().from(deposits).where(eq(deposits.id, depositId)));

describe('ensurePaymentLink', () => {
  it('crea la preferencia con el token del negocio, la seña como referencia y su vencimiento, y guarda el link', async () => {
    const fixture = await createBookableFixture(db, { settings: { depositPaymentOptions: 'mercadopago' } });
    await connectMercadoPago(fixture.tenantId);
    const { appointmentId, depositId } = await book(fixture);
    const { client, created } = fakeClient();

    const link = await ensure(client, fixture.tenantId, appointmentId);

    expect(link).toEqual({ kind: 'link', url: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-1' });
    const deposit = await depositOf(depositId);
    expect(created).toEqual([
      {
        accessToken: 'APP_USR-del-negocio',
        preference: {
          depositId,
          title: 'Seña: Esmaltado semipermanente',
          amountCents: deposit.amountCents,
          notificationUrl: `${PUBLIC_BASE_URL}/webhooks/mercadopago/${fixture.tenantId}`,
          createdAt: BOOKED_AT,
          expiresAt: deposit.expiresAt,
        },
      },
    ]);
    expect(deposit).toMatchObject({
      mercadopagoPreferenceId: 'pref-1',
      mercadopagoPaymentUrl: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-1',
    });
  });

  it('la segunda vez devuelve el mismo link sin crear otra preferencia', async () => {
    const fixture = await createBookableFixture(db, { settings: { depositPaymentOptions: 'mercadopago' } });
    await connectMercadoPago(fixture.tenantId);
    const { appointmentId } = await book(fixture);
    const { client, created } = fakeClient();

    const first = await ensure(client, fixture.tenantId, appointmentId);
    const second = await ensure(client, fixture.tenantId, appointmentId);

    expect(second).toEqual(first);
    expect(created).toHaveLength(1);
  });

  it('sin Mercado Pago conectado no crea nada', async () => {
    const fixture = await createBookableFixture(db, { settings: { depositPaymentOptions: 'mercadopago' } });
    const { appointmentId, depositId } = await book(fixture);
    const { client, created } = fakeClient();

    expect(await ensure(client, fixture.tenantId, appointmentId)).toEqual({ kind: 'not_connected' });
    expect(created).toEqual([]);
    expect(await depositOf(depositId)).toMatchObject({ mercadopagoPreferenceId: null, mercadopagoPaymentUrl: null });
  });

  it.each([
    ['rechaza la preferencia', new MercadoPagoApiError('Mercado Pago respondió 400 a la preferencia', 400, null)],
    ['no responde', new TypeError('fetch failed')],
  ])('si Mercado Pago %s, no guarda nada y lo dice', async (_case, error) => {
    const fixture = await createBookableFixture(db, { settings: { depositPaymentOptions: 'mercadopago' } });
    await connectMercadoPago(fixture.tenantId);
    const { appointmentId, depositId } = await book(fixture);

    expect(await ensure(fakeClient(error).client, fixture.tenantId, appointmentId)).toEqual({ kind: 'failed' });
    expect(await depositOf(depositId)).toMatchObject({ mercadopagoPreferenceId: null, mercadopagoPaymentUrl: null });
  });

  it('un turno sin seña no tiene link', async () => {
    const fixture = await createBookableFixture(db, { settings: { depositRequirement: 'never' } });
    await connectMercadoPago(fixture.tenantId);
    const booked = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: fixture.customerId,
      serviceId: fixture.serviceId,
      professionalId: fixture.professionalId,
      start: at('2026-10-05', '10:00'),
      actor: 'assistant',
      now: BOOKED_AT,
    });
    if (!booked.ok) throw new Error(booked.reason);
    const { client, created } = fakeClient();

    expect(await ensure(client, fixture.tenantId, booked.appointmentId)).toEqual({ kind: 'no_deposit' });
    expect(created).toEqual([]);
  });
});
