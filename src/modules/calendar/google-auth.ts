import { sign } from 'node:crypto';
import { z } from 'zod';
import type { GoogleServiceAccount } from '../../shared/config.js';

/**
 * El token de acceso de la cuenta de servicio de Google (8.4), con `node:crypto` en vez de la
 * librería oficial (decisión 46). Flujo de developers.google.com/identity/protocols/oauth2/service-account:
 * un JWT firmado con RS256 se canjea por un token que dura una hora. Ni la clave, ni el JWT, ni el
 * token aparecen en los errores.
 */
export class GoogleApiError extends Error {
  override name = 'GoogleApiError';
  readonly status: number;
  /** El motivo que da Google, por ejemplo `invalid_grant` o `duplicate`. */
  readonly reason: string | null;

  constructor(message: string, status: number, reason: string | null) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export interface AccessTokenSource {
  get(): Promise<string>;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ASSERTION_LIFETIME_SECONDS = 3600;
/** El token se renueva 5 minutos antes de vencer: un pedido largo no lo ve vencer en el medio. */
const RENEW_BEFORE_MS = 5 * 60_000;

const tokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() });
const tokenError = z.object({ error: z.string(), error_description: z.string().optional() });

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function signedAssertion(serviceAccount: GoogleServiceAccount, scope: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iss: serviceAccount.clientEmail,
    scope,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
  })}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), serviceAccount.privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

export function createAccessTokenSource(options: {
  serviceAccount: GoogleServiceAccount;
  scope: string;
  fetch?: typeof fetch;
  now: () => Date;
}): AccessTokenSource {
  const request = options.fetch ?? globalThis.fetch;
  let cached: { token: string; renewAt: number } | null = null;

  async function requestToken(): Promise<{ token: string; renewAt: number }> {
    const now = options.now();
    const response = await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedAssertion(options.serviceAccount, options.scope, now),
      }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = tokenError.safeParse(body);
      const detail = error.success ? (error.data.error_description ?? error.data.error) : null;
      throw new GoogleApiError(
        detail
          ? `Google rechazó el token de la cuenta de servicio: ${detail}`
          : `Google respondió ${String(response.status)} al pedir el token de la cuenta de servicio`,
        response.status,
        error.success ? error.data.error : null,
      );
    }
    const grant = tokenResponse.parse(body);
    return { token: grant.access_token, renewAt: now.getTime() + grant.expires_in * 1000 - RENEW_BEFORE_MS };
  }

  return {
    async get() {
      if (!cached || options.now().getTime() >= cached.renewAt) cached = await requestToken();
      return cached.token;
    },
  };
}
