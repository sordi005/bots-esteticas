import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { recordPaymentNotification } from '../../src/modules/mercadopago/notification.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { bookAppointment } from '../../src/modules/scheduling/booking.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import type { MercadoPagoClient, TokenGrant } from '../../src/modules/mercadopago/client.js';
import { completeMercadoPagoConnection, loadMercadoPagoCredential } from '../../src/modules/mercadopago/connection.js';
import { createOAuthState } from '../../src/modules/mercadopago/oauth.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { buildWorker } from '../../src/worker.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, createTenantFixture, single } from './support/fixtures.js';
import { connectMercadoPago, fakeMercadoPago } from './support/mercadopago.js';

/** Las tareas de Mercado Pago, con el worker (8.3, 6.7). */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const credentialsKey = randomBytes(32);
const logger = createLogger({ logLevel: 'silent' });
const STATE_SECRET = 'secreto-de-la-aplicacion';
const NOW = new Date('2026-10-29T15:00:00Z');
const DAY_MS = 86_400_000;

afterAll(() => database.close());

// La cola es una sola para todos los negocios: un claim tomaría las tareas de otro test.
beforeEach(async () => {
  await db.delete(scheduledJobs);
});

const grant = (overrides: Partial<TokenGrant> = {}): TokenGrant => ({
  accessToken: 'APP_USR-acceso',
  refreshToken: 'TG-renovacion',
  expiresInSeconds: 180 * 86_400,
  userId: '241983636',
  liveMode: false,
  ...overrides,
});

function fakeClient(): MercadoPagoClient {
  const unused = () => Promise.reject(new Error('No se usa en estos tests'));
  return {
    exchangeCode: () => Promise.resolve(grant()),
    refreshToken: () => Promise.resolve(grant({ accessToken: 'APP_USR-renovado', refreshToken: 'TG-nuevo' })),
    createPreference: unused,
    getPayment: unused,
    searchPayments: unused,
  };
}

async function connectedTenant(client: MercadoPagoClient) {
  const { tenantId } = await createTenantFixture(db);
  await completeMercadoPagoConnection(
    { db, logger, client, credentialsKey, now: () => NOW },
    {
      code: 'TG-codigo',
      state: createOAuthState({ tenantId, now: NOW, secret: STATE_SECRET }),
      redirectUri: 'https://ejemplo.test/mercadopago/oauth/callback',
      stateSecret: STATE_SECRET,
    },
  );
  return tenantId;
}

async function refreshJob(tenantId: string) {
  return single(
    await db
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.kind, 'refresh_mercadopago_token'))),
  );
}

describe('renovación del token de Mercado Pago con el worker (8.3)', () => {
  it('30 días antes del vencimiento, el worker renueva el token y programa la próxima renovación', async () => {
    const client = fakeClient();
    const tenantId = await connectedTenant(client);
    let now = new Date(NOW.getTime() + 150 * DAY_MS - 1);
    const worker = buildWorker({ db, logger, now: () => now, mercadoPago: { client, credentialsKey } });
    onTestFinished(() => worker.stop());

    await worker.runOnce();
    expect(await loadMercadoPagoCredential(db, credentialsKey, tenantId)).toMatchObject({ accessToken: 'APP_USR-acceso' });

    now = new Date(NOW.getTime() + 150 * DAY_MS);
    await worker.runOnce();

    expect(await loadMercadoPagoCredential(db, credentialsKey, tenantId)).toMatchObject({
      accessToken: 'APP_USR-renovado',
      refreshToken: 'TG-nuevo',
    });
    expect(await refreshJob(tenantId)).toMatchObject({
      status: 'pending',
      runAt: new Date(now.getTime() + 150 * DAY_MS),
    });
  });

  it('sin Mercado Pago configurado, el worker no toma la tarea', async () => {
    const tenantId = await connectedTenant(fakeClient());
    const now = new Date(NOW.getTime() + 150 * DAY_MS);
    const worker = buildWorker({ db, logger, now: () => now });
    onTestFinished(() => worker.stop());

    await worker.runOnce();

    expect(await refreshJob(tenantId)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await loadMercadoPagoCredential(db, credentialsKey, tenantId)).toMatchObject({ accessToken: 'APP_USR-acceso' });
  });
});

describe('procesar un pago de Mercado Pago con el worker (8.3)', () => {
  it('el aviso guardado por el webhook lo procesa el worker: el turno queda confirmado', async () => {
    const now = new Date('2026-10-04T12:20:00Z');
    const fixture = await createBookableFixture(db, { settings: { depositPaymentOptions: 'mercadopago' } });
    await connectMercadoPago(db, credentialsKey, fixture.tenantId);
    const booked = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: fixture.customerId,
      serviceId: fixture.serviceId,
      professionalId: fixture.professionalId,
      start: new Date('2026-10-05T13:00:00Z'),
      actor: 'assistant',
      now: new Date('2026-10-04T12:00:00Z'),
    });
    if (!booked.ok || !booked.deposit) throw new Error('La reserva de prueba no quedó pendiente de seña');
    const deposit = single(await db.select().from(deposits).where(eq(deposits.id, booked.deposit.id)));
    const paymentId = '7'.repeat(12);
    const { client } = fakeMercadoPago({
      payments: [{ id: paymentId, status: 'approved', externalReference: deposit.id, amountCents: deposit.amountCents, currency: 'ARS' }],
    });
    const worker = buildWorker({ db, logger, now: () => now, mercadoPago: { client, credentialsKey } });
    onTestFinished(() => worker.stop());

    await recordPaymentNotification(db, { tenantId: fixture.tenantId, paymentId, now });
    await worker.runOnce();

    expect(
      single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, booked.appointmentId))).status,
    ).toBe('CONFIRMED');
  });
});
