import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Conexión de un negocio a Mercado Pago por OAuth (8.3). El link lleva un `state` firmado por el
 * servidor: dice de qué negocio es y vence a los 15 minutos, así la vuelta no necesita guardar
 * nada y nadie puede conectar su cuenta a otro negocio. Sin PKCE: el secreto vive en el servidor.
 */
export const OAUTH_STATE_TTL_MS = 15 * 60_000;

const AUTHORIZATION_URL = 'https://auth.mercadopago.com/authorization';

const stateData = z.object({ tenantId: z.string().min(1), expiresAt: z.number().int(), nonce: z.string() });

const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function createOAuthState(input: { tenantId: string; now: Date; secret: string }): string {
  const data = Buffer.from(
    JSON.stringify({
      tenantId: input.tenantId,
      expiresAt: input.now.getTime() + OAUTH_STATE_TTL_MS,
      // Mercado Pago pide un identificador único por intento.
      nonce: randomBytes(12).toString('base64url'),
    }),
  ).toString('base64url');
  return `${data}.${sign(data, input.secret)}`;
}

/** El negocio del state, o null si no lo firmamos nosotros o ya venció. */
export function verifyOAuthState(state: string, options: { now: Date; secret: string }): string | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [data = '', signature = ''] = parts;

  const expected = Buffer.from(sign(data, options.secret));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = stateData.safeParse(decoded);
  if (!parsed.success || options.now.getTime() > parsed.data.expiresAt) return null;
  return parsed.data.tenantId;
}

/** El link que abre la dueña para autorizar a la aplicación del servicio. */
export function authorizationUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(AUTHORIZATION_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('platform_id', 'mp');
  url.searchParams.set('state', input.state);
  url.searchParams.set('redirect_uri', input.redirectUri);
  return url.toString();
}
