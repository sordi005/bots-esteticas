import { describe, expect, it } from 'vitest';
import {
  authorizationUrl,
  connectionLink,
  createOAuthState,
  OAUTH_CALLBACK_PATH,
  OAUTH_STATE_TTL_MS,
  verifyOAuthState,
} from '../../../src/modules/mercadopago/oauth.js';

const SECRET = 'secreto-de-la-aplicacion';
const TENANT_ID = '0b9c5a52-4f4e-4c4e-9a37-3f0d7e1c2b11';
const NOW = new Date('2026-10-29T15:00:00Z');

describe('state de OAuth (8.3)', () => {
  it('la vuelta reconoce el negocio que pidió el link', () => {
    const state = createOAuthState({ tenantId: TENANT_ID, now: NOW, secret: SECRET });

    expect(verifyOAuthState(state, { now: NOW, secret: SECRET })).toBe(TENANT_ID);
  });

  it('cada link lleva un state distinto, aunque sea del mismo negocio y a la misma hora', () => {
    const first = createOAuthState({ tenantId: TENANT_ID, now: NOW, secret: SECRET });
    const second = createOAuthState({ tenantId: TENANT_ID, now: NOW, secret: SECRET });

    expect(first).not.toBe(second);
  });

  it('vale hasta los 15 minutos justos y después ya no', () => {
    const state = createOAuthState({ tenantId: TENANT_ID, now: NOW, secret: SECRET });
    const at = (ms: number) => new Date(NOW.getTime() + ms);

    expect(OAUTH_STATE_TTL_MS).toBe(15 * 60_000);
    expect(verifyOAuthState(state, { now: at(OAUTH_STATE_TTL_MS), secret: SECRET })).toBe(TENANT_ID);
    expect(verifyOAuthState(state, { now: at(OAUTH_STATE_TTL_MS + 1), secret: SECRET })).toBeNull();
  });

  it('un state firmado con otra clave no vale', () => {
    const state = createOAuthState({ tenantId: TENANT_ID, now: NOW, secret: 'otra-clave' });

    expect(verifyOAuthState(state, { now: NOW, secret: SECRET })).toBeNull();
  });

  it('nadie puede cambiar el negocio del state sin romper la firma', () => {
    const state = createOAuthState({ tenantId: TENANT_ID, now: NOW, secret: SECRET });
    const [data, signature] = state.split('.');
    const decoded = Buffer.from(data ?? '', 'base64url').toString('utf8');
    const forged = Buffer.from(decoded.replace(TENANT_ID, '11111111-1111-4111-8111-111111111111')).toString('base64url');

    expect(verifyOAuthState(`${forged}.${signature ?? ''}`, { now: NOW, secret: SECRET })).toBeNull();
  });

  it.each([
    ['vacío', ''],
    ['sin firma', 'abc'],
    ['con basura', 'no.es.un.state'],
    ['con datos que no son JSON', `${Buffer.from('hola').toString('base64url')}.firma`],
  ])('un state %s no vale', (_case, state) => {
    expect(verifyOAuthState(state, { now: NOW, secret: SECRET })).toBeNull();
  });
});

describe('authorizationUrl', () => {
  it('arma el link de autorización de Mercado Pago con la aplicación, la vuelta y el state', () => {
    const url = new URL(
      authorizationUrl({
        clientId: '4934588586838432',
        redirectUri: 'https://ejemplo.ngrok-free.dev/mercadopago/oauth/callback',
        state: 'el-state',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://auth.mercadopago.com/authorization');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '4934588586838432',
      response_type: 'code',
      platform_id: 'mp',
      state: 'el-state',
      redirect_uri: 'https://ejemplo.ngrok-free.dev/mercadopago/oauth/callback',
    });
  });
});

describe('connectionLink (pnpm mercadopago:connect)', () => {
  const app = { clientId: '4934588586838432', clientSecret: SECRET, publicBaseUrl: 'https://ejemplo.ngrok-free.dev' };

  it('vuelve a la ruta de la vuelta de OAuth en la URL pública', () => {
    const url = new URL(connectionLink({ tenantId: TENANT_ID, now: NOW, app }));

    expect(OAUTH_CALLBACK_PATH).toBe('/mercadopago/oauth/callback');
    expect(url.searchParams.get('redirect_uri')).toBe('https://ejemplo.ngrok-free.dev/mercadopago/oauth/callback');
    expect(url.searchParams.get('client_id')).toBe('4934588586838432');
  });

  it('lleva un state del negocio firmado con el secreto de la aplicación, que la vuelta acepta', () => {
    const state = new URL(connectionLink({ tenantId: TENANT_ID, now: NOW, app })).searchParams.get('state') ?? '';

    expect(verifyOAuthState(state, { now: NOW, secret: SECRET })).toBe(TENANT_ID);
    expect(verifyOAuthState(state, { now: NOW, secret: 'otra-clave' })).toBeNull();
  });
});
