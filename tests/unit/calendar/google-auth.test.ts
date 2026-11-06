import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccessTokenSource, GoogleApiError } from '../../../src/modules/calendar/google-auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = {
  clientEmail: 'calendario@bots-esteticas.iam.gserviceaccount.com',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const T0 = new Date('2026-11-04T15:00:00Z');
const MINUTE_MS = 60_000;

interface TokenRequest {
  url: string;
  body: URLSearchParams;
}

/** Un endpoint de tokens falso: responde lo que se le pide y anota cada pedido. */
function fakeTokenEndpoint(response: { status: number; body: unknown } = { status: 200, body: tokenBody('ya29.primero') }) {
  const requests: TokenRequest[] = [];
  const responses = [response];
  const fetchFn: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, body: new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : '') });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (!next) throw new Error('Sin respuesta');
    return Promise.resolve(
      new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } }),
    );
  };
  return { fetch: fetchFn, requests, then: (body: unknown) => responses.push({ status: 200, body }) };
}

// El ejemplo de respuesta de developers.google.com/identity/protocols/oauth2/service-account.
function tokenBody(accessToken: string) {
  return { access_token: accessToken, scope: SCOPE, token_type: 'Bearer', expires_in: 3600 };
}

function decodeSegment(segment: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('createAccessTokenSource: el token de acceso de la cuenta de servicio (8.4)', () => {
  it('pide el token con un JWT firmado con RS256 por la cuenta de servicio', async () => {
    const endpoint = fakeTokenEndpoint();
    const tokens = createAccessTokenSource({ serviceAccount: SERVICE_ACCOUNT, scope: SCOPE, fetch: endpoint.fetch, now: () => T0 });

    expect(await tokens.get()).toBe('ya29.primero');

    const [request] = endpoint.requests;
    expect(request?.url).toBe('https://oauth2.googleapis.com/token');
    expect(request?.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = (request?.body.get('assertion') ?? '').split('.');
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeSegment(claims)).toEqual({
      iss: SERVICE_ACCOUNT.clientEmail,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: T0.getTime() / 1000,
      exp: T0.getTime() / 1000 + 3600,
    });
    const signed = Buffer.from(`${header ?? ''}.${claims ?? ''}`);
    expect(verify('RSA-SHA256', signed, publicKey, Buffer.from(signature ?? '', 'base64url'))).toBe(true);
  });

  it('reusa el token mientras le falten más de 5 minutos para vencer', async () => {
    let now = T0;
    const endpoint = fakeTokenEndpoint();
    const tokens = createAccessTokenSource({ serviceAccount: SERVICE_ACCOUNT, scope: SCOPE, fetch: endpoint.fetch, now: () => now });

    await tokens.get();
    now = new Date(T0.getTime() + 54 * MINUTE_MS);
    expect(await tokens.get()).toBe('ya29.primero');

    expect(endpoint.requests).toHaveLength(1);
  });

  it('a 5 minutos de vencer pide uno nuevo', async () => {
    let now = T0;
    const endpoint = fakeTokenEndpoint();
    endpoint.then(tokenBody('ya29.segundo'));
    const tokens = createAccessTokenSource({ serviceAccount: SERVICE_ACCOUNT, scope: SCOPE, fetch: endpoint.fetch, now: () => now });

    await tokens.get();
    now = new Date(T0.getTime() + 55 * MINUTE_MS);

    expect(await tokens.get()).toBe('ya29.segundo');
    expect(endpoint.requests).toHaveLength(2);
  });

  it('si Google rechaza la firma, el error dice por qué y no muestra el JWT', async () => {
    const endpoint = fakeTokenEndpoint({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' },
    });
    const tokens = createAccessTokenSource({ serviceAccount: SERVICE_ACCOUNT, scope: SCOPE, fetch: endpoint.fetch, now: () => T0 });

    const error = await tokens.get().catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ status: 400, reason: 'invalid_grant' });
    expect((error as Error).message).toContain('Invalid JWT Signature.');
    expect((error as Error).message).not.toContain(endpoint.requests[0]?.body.get('assertion') ?? 'sin-assertion');
  });

  it('un error no queda guardado: el próximo pedido vuelve a intentar', async () => {
    const endpoint = fakeTokenEndpoint({ status: 503, body: { error: 'backend_error' } });
    endpoint.then(tokenBody('ya29.despues'));
    const tokens = createAccessTokenSource({ serviceAccount: SERVICE_ACCOUNT, scope: SCOPE, fetch: endpoint.fetch, now: () => T0 });

    await expect(tokens.get()).rejects.toBeInstanceOf(GoogleApiError);
    expect(await tokens.get()).toBe('ya29.despues');
  });
});
