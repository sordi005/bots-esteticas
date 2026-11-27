import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { MercadoPagoApiError, type MercadoPagoClient, type TokenGrant } from '../../src/modules/mercadopago/client.js';
import {
  completeMercadoPagoConnection,
  loadMercadoPagoCredential,
  refreshMercadoPagoToken,
  refreshTokenJobHandler,
  TOKEN_REFRESH_LEAD_MS,
  TOKEN_REFRESH_RETRY_MS,
} from '../../src/modules/mercadopago/connection.js';
import { createOAuthState } from '../../src/modules/mercadopago/oauth.js';
import { tenantCredentials } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single } from './support/fixtures.js';

/**
 * Conexión de un negocio a Mercado Pago por OAuth (8.3): la vuelta canjea el código, guarda los
 * tokens cifrados con su vencimiento y programa la renovación 30 días antes.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = pino({ level: 'silent' });
const key = randomBytes(32);
const STATE_SECRET = 'secreto-de-la-aplicacion';
const REDIRECT_URI = 'https://ejemplo.test/mercadopago/oauth/callback';
const NOW = new Date('2026-10-29T15:00:00Z');
const DAY_MS = 86_400_000;

afterAll(() => database.close());

const grant = (overrides: Partial<TokenGrant> = {}): TokenGrant => ({
  accessToken: 'APP_USR-acceso',
  refreshToken: 'TG-renovacion',
  expiresInSeconds: 180 * 86_400,
  userId: '241983636',
  liveMode: false,
  ...overrides,
});

/** Un cliente que solo sabe de tokens: lo demás no se usa acá. */
function tokenClient(handlers: Partial<Pick<MercadoPagoClient, 'exchangeCode' | 'refreshToken'>>): MercadoPagoClient {
  const unused = () => Promise.reject(new Error('No se usa en estos tests'));
  return {
    exchangeCode: handlers.exchangeCode ?? unused,
    refreshToken: handlers.refreshToken ?? unused,
    createPreference: unused,
    getPayment: unused,
    searchPayments: unused,
  };
}

const deps = (client: MercadoPagoClient, now = NOW) => ({ db, logger, client, credentialsKey: key, now: () => now });

async function refreshJob(tenantId: string) {
  return single(
    await db
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.kind, 'refresh_mercadopago_token'))),
  );
}

async function connect(tenantId: string, client: MercadoPagoClient) {
  const state = createOAuthState({ tenantId, now: NOW, secret: STATE_SECRET });
  return completeMercadoPagoConnection(deps(client), { code: 'TG-codigo', state, redirectUri: REDIRECT_URI, stateSecret: STATE_SECRET });
}

describe('completeMercadoPagoConnection', () => {
  it('canjea el código con la misma vuelta y guarda los tokens cifrados con su vencimiento', async () => {
    const { tenantId } = await createTenantFixture(db);
    const exchanged: unknown[] = [];

    const result = await connect(
      tenantId,
      tokenClient({
        exchangeCode: (input) => {
          exchanged.push(input);
          return Promise.resolve(grant());
        },
      }),
    );

    expect(result).toEqual({ status: 'connected', tenantId });
    expect(exchanged).toEqual([{ code: 'TG-codigo', redirectUri: REDIRECT_URI }]);
    expect(await loadMercadoPagoCredential(db, key, tenantId)).toEqual({
      accessToken: 'APP_USR-acceso',
      refreshToken: 'TG-renovacion',
      userId: '241983636',
      liveMode: false,
    });
    const row = single(await db.select().from(tenantCredentials).where(eq(tenantCredentials.tenantId, tenantId)));
    expect(row.expiresAt).toEqual(new Date(NOW.getTime() + 180 * DAY_MS));
    expect(row.ciphertext.toString('latin1')).not.toContain('APP_USR');
  });

  it('programa la renovación 30 días antes del vencimiento', async () => {
    const { tenantId } = await createTenantFixture(db);

    await connect(tenantId, tokenClient({ exchangeCode: () => Promise.resolve(grant()) }));

    expect(TOKEN_REFRESH_LEAD_MS).toBe(30 * DAY_MS);
    const job = await refreshJob(tenantId);
    expect(job).toMatchObject({ key: tenantId, status: 'pending' });
    expect(job.runAt).toEqual(new Date(NOW.getTime() + 150 * DAY_MS));
  });

  it('un state vencido o ajeno no canjea nada', async () => {
    const { tenantId } = await createTenantFixture(db);
    const state = createOAuthState({ tenantId, now: NOW, secret: 'otra-clave' });

    const result = await completeMercadoPagoConnection(
      deps(tokenClient({ exchangeCode: () => Promise.reject(new Error('No debería canjear')) })),
      { code: 'TG-codigo', state, redirectUri: REDIRECT_URI, stateSecret: STATE_SECRET },
    );

    expect(result).toEqual({ status: 'invalid_state' });
    expect(await loadMercadoPagoCredential(db, key, tenantId)).toBeNull();
  });

  it('si Mercado Pago rechaza el código, no guarda nada', async () => {
    const { tenantId } = await createTenantFixture(db);

    const result = await connect(
      tenantId,
      tokenClient({ exchangeCode: () => Promise.reject(new MercadoPagoApiError('invalid_grant', 400, 'invalid_grant')) }),
    );

    expect(result).toEqual({ status: 'rejected', tenantId });
    expect(await loadMercadoPagoCredential(db, key, tenantId)).toBeNull();
  });

  it('conectar de nuevo reemplaza la cuenta anterior', async () => {
    const { tenantId } = await createTenantFixture(db);
    await connect(tenantId, tokenClient({ exchangeCode: () => Promise.resolve(grant()) }));

    await connect(tenantId, tokenClient({ exchangeCode: () => Promise.resolve(grant({ accessToken: 'APP_USR-otra', userId: '9' })) }));

    expect(await loadMercadoPagoCredential(db, key, tenantId)).toMatchObject({ accessToken: 'APP_USR-otra', userId: '9' });
  });
});

describe('refreshMercadoPagoToken', () => {
  it('renueva con el token de renovación guardado y reprograma la próxima', async () => {
    const { tenantId } = await createTenantFixture(db);
    await connect(tenantId, tokenClient({ exchangeCode: () => Promise.resolve(grant()) }));
    const later = new Date(NOW.getTime() + 150 * DAY_MS);
    const used: string[] = [];

    const result = await refreshMercadoPagoToken(
      deps(
        tokenClient({
          refreshToken: ({ refreshToken }) => {
            used.push(refreshToken);
            return Promise.resolve(grant({ accessToken: 'APP_USR-renovado', refreshToken: 'TG-nuevo' }));
          },
        }),
        later,
      ),
      { tenantId },
    );

    expect(result).toBe('refreshed');
    expect(used).toEqual(['TG-renovacion']);
    expect(await loadMercadoPagoCredential(db, key, tenantId)).toMatchObject({
      accessToken: 'APP_USR-renovado',
      refreshToken: 'TG-nuevo',
    });
    expect((await refreshJob(tenantId)).runAt).toEqual(new Date(later.getTime() + 150 * DAY_MS));
  });

  it('un negocio que ya no tiene Mercado Pago no renueva nada (regla 7)', async () => {
    const { tenantId } = await createTenantFixture(db);

    const result = await refreshMercadoPagoToken(
      deps(tokenClient({ refreshToken: () => Promise.reject(new Error('No debería renovar')) })),
      { tenantId },
    );

    expect(result).toBe('not_connected');
  });

  it('si Mercado Pago rechaza la renovación, falla para que la cola reintente y deja los tokens como estaban', async () => {
    const { tenantId } = await createTenantFixture(db);
    await connect(tenantId, tokenClient({ exchangeCode: () => Promise.resolve(grant()) }));

    const promise = refreshMercadoPagoToken(
      deps(tokenClient({ refreshToken: () => Promise.reject(new MercadoPagoApiError('invalid_grant', 400, 'invalid_grant')) })),
      { tenantId },
    );

    await expect(promise).rejects.toThrow(MercadoPagoApiError);
    expect(await loadMercadoPagoCredential(db, key, tenantId)).toMatchObject({ accessToken: 'APP_USR-acceso' });
  });
});

describe('refreshTokenJobHandler: la tarea de renovación (8.3, H14)', () => {
  async function runHandler(tenantId: string, error: Error, lastAttempt: boolean) {
    const job = await refreshJob(tenantId);
    const handler = refreshTokenJobHandler(deps(tokenClient({ refreshToken: () => Promise.reject(error) })));
    const claimed = { id: job.id, tenantId, kind: job.kind, key: job.key, payload: {}, attempts: 3, lockToken: 'x' };
    await expect(handler(claimed, { signal: new AbortController().signal, lastAttempt })).rejects.toBe(error);
    return refreshJob(tenantId);
  }

  it('si el último intento falla por un error que se reintenta, se vuelve a programar para 24 horas después', async () => {
    const { tenantId } = await createTenantFixture(db);
    await connect(tenantId, tokenClient({ exchangeCode: () => Promise.resolve(grant()) }));

    const job = await runHandler(tenantId, new MercadoPagoApiError('Mercado Pago respondió 500', 500, null), true);

    expect(TOKEN_REFRESH_RETRY_MS).toBe(DAY_MS);
    expect(job.runAt).toEqual(new Date(NOW.getTime() + DAY_MS));
  });

  it('antes del último intento no se reprograma: siguen los reintentos de la cola', async () => {
    const { tenantId } = await createTenantFixture(db);
    await connect(tenantId, tokenClient({ exchangeCode: () => Promise.resolve(grant()) }));
    const before = await refreshJob(tenantId);

    const job = await runHandler(tenantId, new MercadoPagoApiError('Mercado Pago respondió 500', 500, null), false);

    expect(job.runAt).toEqual(before.runAt);
  });

  it('con invalid_grant no se reprograma: la dueña tiene que volver a conectar', async () => {
    const { tenantId } = await createTenantFixture(db);
    await connect(tenantId, tokenClient({ exchangeCode: () => Promise.resolve(grant()) }));
    const before = await refreshJob(tenantId);

    const job = await runHandler(tenantId, new MercadoPagoApiError('invalid_grant', 400, 'invalid_grant'), true);

    expect(job.runAt).toEqual(before.runAt);
  });
});
