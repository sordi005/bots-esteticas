import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { z } from 'zod';
import { scheduleJob } from '../jobs/queue.js';
import type { JobHandler } from '../jobs/runner.js';
import { loadCredential, saveCredential } from '../tenants/credentials.js';
import { MercadoPagoApiError, type MercadoPagoClient, type TokenGrant } from './client.js';
import { verifyOAuthState } from './oauth.js';

/**
 * La cuenta de Mercado Pago de cada negocio (8.3): los tokens viven cifrados en `tenant_credentials`
 * (tipo `mercadopago`) con su vencimiento, y la tarea "renovar el token" corre 30 días antes.
 */
export const TOKEN_REFRESH_LEAD_MS = 30 * 86_400_000;

/** Lo que se guarda cifrado. `userId` es la cuenta de Mercado Pago que autorizó. */
export const mercadoPagoCredentialSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  userId: z.string().min(1),
  liveMode: z.boolean(),
});
export type MercadoPagoCredential = z.infer<typeof mercadoPagoCredentialSchema>;

export interface MercadoPagoConnectionDependencies {
  db: NodePgDatabase;
  logger: Logger;
  client: MercadoPagoClient;
  credentialsKey: Buffer;
  now: () => Date;
}

/** La credencial del negocio, o null si no conectó Mercado Pago. */
export async function loadMercadoPagoCredential(
  db: NodePgDatabase,
  key: Buffer,
  tenantId: string,
): Promise<MercadoPagoCredential | null> {
  const value = await loadCredential(db, key, { tenantId, kind: 'mercadopago' });
  return value === null ? null : mercadoPagoCredentialSchema.parse(value);
}

/** Guarda los tokens y programa su renovación, en la misma transacción. */
async function saveGrant(db: NodePgDatabase, key: Buffer, input: { tenantId: string; grant: TokenGrant; now: Date }) {
  const { tenantId, grant, now } = input;
  const expiresAt = new Date(now.getTime() + grant.expiresInSeconds * 1000);
  const value: MercadoPagoCredential = {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    userId: grant.userId,
    liveMode: grant.liveMode,
  };

  await db.transaction(async (tx) => {
    await saveCredential(tx, key, { tenantId, kind: 'mercadopago', value, expiresAt });
    await scheduleJob(tx, {
      tenantId,
      kind: 'refresh_mercadopago_token',
      key: tenantId,
      runAt: new Date(Math.max(now.getTime(), expiresAt.getTime() - TOKEN_REFRESH_LEAD_MS)),
    });
  });
}

export type ConnectionResult =
  | { status: 'connected'; tenantId: string }
  /** El link no lo firmamos nosotros o venció: no se canjea nada. */
  | { status: 'invalid_state' }
  /** Mercado Pago no aceptó el código (vencido, ya usado, otra vuelta). */
  | { status: 'rejected'; tenantId: string };

/** La vuelta de OAuth: verifica el state, canjea el código y guarda la cuenta del negocio. */
export async function completeMercadoPagoConnection(
  deps: MercadoPagoConnectionDependencies,
  input: { code: string; state: string; redirectUri: string; stateSecret: string },
): Promise<ConnectionResult> {
  const now = deps.now();
  const tenantId = verifyOAuthState(input.state, { now, secret: input.stateSecret });
  if (!tenantId) return { status: 'invalid_state' };

  let grant: TokenGrant;
  try {
    grant = await deps.client.exchangeCode({ code: input.code, redirectUri: input.redirectUri });
  } catch (error) {
    if (!(error instanceof MercadoPagoApiError)) throw error;
    deps.logger.warn({ tenantId, status: error.status, code: error.code }, 'Mercado Pago no aceptó el código de autorización');
    return { status: 'rejected', tenantId };
  }

  await saveGrant(deps.db, deps.credentialsKey, { tenantId, grant, now });
  deps.logger.info({ tenantId, liveMode: grant.liveMode }, 'Mercado Pago conectado');
  return { status: 'connected', tenantId };
}

export type RefreshResult = 'refreshed' | 'not_connected';

/**
 * Renueva el token del negocio. Si Mercado Pago lo rechaza, lanza: la cola reintenta y, después del
 * último intento, la tarea queda fallida con el error en el log (la alerta a Yordi llega en H14).
 */
export async function refreshMercadoPagoToken(
  deps: MercadoPagoConnectionDependencies,
  input: { tenantId: string },
): Promise<RefreshResult> {
  const credential = await loadMercadoPagoCredential(deps.db, deps.credentialsKey, input.tenantId);
  if (!credential) return 'not_connected';

  const grant = await deps.client.refreshToken({ refreshToken: credential.refreshToken });
  await saveGrant(deps.db, deps.credentialsKey, { tenantId: input.tenantId, grant, now: deps.now() });
  return 'refreshed';
}

export function refreshTokenJobHandler(deps: MercadoPagoConnectionDependencies): JobHandler {
  return async (job) => {
    const result = await refreshMercadoPagoToken(deps, { tenantId: job.tenantId });
    deps.logger.info({ tenantId: job.tenantId, result }, 'Renovación del token de Mercado Pago');
  };
}
