import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { MercadoPagoApiError, type MercadoPagoClient } from '../../src/modules/mercadopago/client.js';
import { completeMercadoPagoConnection, loadMercadoPagoCredential } from '../../src/modules/mercadopago/connection.js';
import { recordPaymentNotification } from '../../src/modules/mercadopago/notification.js';
import { createOAuthState } from '../../src/modules/mercadopago/oauth.js';
import { buildServer } from '../../src/server.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single } from './support/fixtures.js';

/**
 * Las rutas de Mercado Pago (8.3): la vuelta de OAuth y el webhook de pagos, que solo valida la
 * firma, guarda programando la tarea y responde 200 (regla 6).
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = createLogger({ logLevel: 'silent' });
const credentialsKey = randomBytes(32);
const STATE_SECRET = 'secreto-de-la-aplicacion';
const WEBHOOK_SECRET = 'clave-de-webhooks';
const REDIRECT_URI = 'https://ejemplo.test/mercadopago/oauth/callback';
const NOW = new Date('2026-10-29T15:00:00Z');

const exchanged: string[] = [];
const client: MercadoPagoClient = {
  exchangeCode: ({ code }) => {
    exchanged.push(code);
    return code === 'TG-vencido'
      ? Promise.reject(new MercadoPagoApiError('invalid_grant', 400, 'invalid_grant'))
      : Promise.resolve({
          accessToken: 'APP_USR-acceso',
          refreshToken: 'TG-renovacion',
          expiresInSeconds: 180 * 86_400,
          userId: '241983636',
          liveMode: false,
        });
  },
  refreshToken: () => Promise.reject(new Error('No se usa')),
  createPreference: () => Promise.reject(new Error('No se usa')),
  getPayment: () => Promise.reject(new Error('No se usa')),
  searchPayments: () => Promise.reject(new Error('No se usa')),
};

const server = buildServer({
  healthChecks: {},
  mercadoPago: {
    webhookSecret: WEBHOOK_SECRET,
    connect: ({ code, state }) =>
      completeMercadoPagoConnection(
        { db, logger, client, credentialsKey, now: () => NOW },
        { code, state, redirectUri: REDIRECT_URI, stateSecret: STATE_SECRET },
      ),
    onPayment: (notification) => recordPaymentNotification(db, { ...notification, now: NOW }),
  },
});

afterAll(async () => {
  await server.close();
  await database.close();
});

function signature(dataId: string, requestId: string, ts = '1742505638683', secret = WEBHOOK_SECRET) {
  const hash = createHmac('sha256', secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
  return `ts=${ts},v1=${hash}`;
}

function notify(tenantId: string, input: { dataId?: string; type?: string; signature?: string } = {}) {
  const dataId = input.dataId ?? '1319015496';
  const type = input.type ?? 'payment';
  const requestId = randomUUID();
  return server.inject({
    method: 'POST',
    url: `/webhooks/mercadopago/${tenantId}?data.id=${dataId}&type=${type}`,
    headers: {
      'content-type': 'application/json',
      'x-request-id': requestId,
      'x-signature': input.signature ?? signature(dataId, requestId),
    },
    payload: JSON.stringify({ action: 'payment.updated', type, data: { id: dataId } }),
  });
}

async function paymentJobs(tenantId: string) {
  return db
    .select()
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.kind, 'process_mercadopago_payment')));
}

describe('GET /mercadopago/oauth/callback', () => {
  const callback = (query: string) => server.inject({ method: 'GET', url: `/mercadopago/oauth/callback?${query}` });

  it('con un state nuestro guarda la cuenta y le muestra a la dueña que quedó conectada', async () => {
    const { tenantId } = await createTenantFixture(db);
    const state = createOAuthState({ tenantId, now: NOW, secret: STATE_SECRET });

    const response = await callback(`code=TG-codigo&state=${state}`);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Mercado Pago quedó conectado');
    expect(await loadMercadoPagoCredential(db, credentialsKey, tenantId)).toMatchObject({ accessToken: 'APP_USR-acceso' });
  });

  it('con un state ajeno no canjea nada y pide un link nuevo', async () => {
    const { tenantId } = await createTenantFixture(db);
    const state = createOAuthState({ tenantId, now: NOW, secret: 'otra-clave' });
    const before = exchanged.length;

    const response = await callback(`code=TG-codigo&state=${state}`);

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('link nuevo');
    expect(exchanged).toHaveLength(before);
    expect(await loadMercadoPagoCredential(db, credentialsKey, tenantId)).toBeNull();
  });

  it('si Mercado Pago no acepta el código, pide un link nuevo', async () => {
    const { tenantId } = await createTenantFixture(db);
    const state = createOAuthState({ tenantId, now: NOW, secret: STATE_SECRET });

    const response = await callback(`code=TG-vencido&state=${state}`);

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('link nuevo');
    expect(await loadMercadoPagoCredential(db, credentialsKey, tenantId)).toBeNull();
  });

  it.each([
    ['sin código (la dueña no autorizó)', 'state=algo&error=access_denied'],
    ['sin state', 'code=TG-codigo'],
  ])('%s responde 400 sin canjear nada', async (_case, query) => {
    const before = exchanged.length;

    const response = await callback(query);

    expect(response.statusCode).toBe(400);
    expect(exchanged).toHaveLength(before);
  });
});

describe('POST /webhooks/mercadopago/:tenantId', () => {
  it('un aviso de pago firmado programa la tarea con el id del pago como clave y responde 200', async () => {
    const { tenantId } = await createTenantFixture(db);

    const response = await notify(tenantId);

    expect(response.statusCode).toBe(200);
    expect(single(await paymentJobs(tenantId))).toMatchObject({ key: '1319015496', status: 'pending', runAt: NOW });
  });

  it('el mismo aviso repetido es la misma tarea (decisión 40)', async () => {
    const { tenantId } = await createTenantFixture(db);

    await notify(tenantId);
    await notify(tenantId);

    expect(await paymentJobs(tenantId)).toHaveLength(1);
  });

  it.each([
    ['con otra clave', (dataId: string) => signature(dataId, 'otro-pedido', '1742505638683', 'otra-clave')],
    ['sin firma', () => ''],
  ])('%s responde 401 y no guarda nada', async (_case, sign) => {
    const { tenantId } = await createTenantFixture(db);

    const response = await notify(tenantId, { signature: sign('1319015496') });

    expect(response.statusCode).toBe(401);
    expect(await paymentJobs(tenantId)).toEqual([]);
  });

  it('un aviso que no es de un pago responde 200 y se ignora', async () => {
    const { tenantId } = await createTenantFixture(db);

    const response = await notify(tenantId, { type: 'merchant_order' });

    expect(response.statusCode).toBe(200);
    expect(await paymentJobs(tenantId)).toEqual([]);
  });

  it.each([
    ['de un pago', 'id=186474674153&topic=payment'],
    ['de una orden', 'id=45782807547&topic=merchant_order'],
  ])('un aviso en el formato viejo (IPN) %s responde 200 y se ignora, aunque la firma no valide', async (_case, query) => {
    // Lo encontró la prueba manual de H11: Mercado Pago manda además estos avisos, sin data.id, y la firma
    // no valida. Con 401 los reintenta cada 15 minutos; el aviso nuevo (data.id, type=payment) ya trae el pago.
    const { tenantId } = await createTenantFixture(db);

    const response = await server.inject({
      method: 'POST',
      url: `/webhooks/mercadopago/${tenantId}?${query}`,
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID(), 'x-signature': 'ts=1,v1=abc' },
      payload: JSON.stringify({ resource: '186474674153', topic: 'payment' }),
    });

    expect(response.statusCode).toBe(200);
    expect(await paymentJobs(tenantId)).toEqual([]);
  });

  it('un negocio que no existe responde 200 sin guardar nada (Mercado Pago no reintenta para siempre)', async () => {
    const response = await notify(randomUUID());

    expect(response.statusCode).toBe(200);
  });

  it('un id de negocio que no es un uuid responde 404', async () => {
    const response = await notify('no-es-un-uuid');

    expect(response.statusCode).toBe(404);
  });
});
