import { describe, expect, it } from 'vitest';
import { createMercadoPagoClient, MercadoPagoApiError } from '../../../src/modules/mercadopago/client.js';

const TOKEN = 'APP_USR-token-secreto';

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown, captured: Captured[] = []): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
  };
}

const TOKEN_RESPONSE = {
  access_token: 'APP_USR-nuevo',
  token_type: 'bearer',
  expires_in: 15_552_000,
  scope: 'read write offline_access',
  user_id: 241_983_636,
  refresh_token: 'TG-nuevo',
  public_key: 'APP_USR-publica',
  live_mode: false,
};

const PAYMENT = {
  id: 1_234_567_890,
  status: 'approved',
  external_reference: '5f0c7c34-2f5e-4c1b-9d55-3a8d6f2b1c90',
  transaction_amount: 5400,
  currency_id: 'ARS',
};

function client(fakeRequest: typeof fetch, testToken = false) {
  return createMercadoPagoClient({
    clientId: '4934588586838432',
    clientSecret: 'secreto-app',
    testToken,
    fetch: fakeRequest,
  });
}

function bodyOf(request: Captured | undefined): unknown {
  const body = request?.init.body;
  if (typeof body !== 'string') throw new Error('El pedido no tiene cuerpo JSON');
  return JSON.parse(body);
}

describe('createMercadoPagoClient: tokens', () => {
  it('canjea el código con la aplicación y la misma redirección', async () => {
    const captured: Captured[] = [];

    await client(fakeFetch(200, TOKEN_RESPONSE, captured)).exchangeCode({
      code: 'TG-codigo',
      redirectUri: 'https://x.test/mercadopago/oauth/callback',
    });

    const [request] = captured;
    expect(request?.url).toBe('https://api.mercadopago.com/oauth/token');
    expect(request?.init.method).toBe('POST');
    expect(bodyOf(request)).toEqual({
      client_id: '4934588586838432',
      client_secret: 'secreto-app',
      grant_type: 'authorization_code',
      code: 'TG-codigo',
      redirect_uri: 'https://x.test/mercadopago/oauth/callback',
      test_token: false,
    });
  });

  it('en desarrollo pide tokens de prueba (8.3)', async () => {
    const captured: Captured[] = [];

    await client(fakeFetch(200, TOKEN_RESPONSE, captured), true).exchangeCode({ code: 'TG-codigo', redirectUri: 'https://x.test/cb' });

    expect(bodyOf(captured[0])).toMatchObject({ test_token: true });
  });

  it('renueva con el token de renovación', async () => {
    const captured: Captured[] = [];

    const grant = await client(fakeFetch(200, TOKEN_RESPONSE, captured)).refreshToken({ refreshToken: 'TG-viejo' });

    expect(bodyOf(captured[0])).toEqual({
      client_id: '4934588586838432',
      client_secret: 'secreto-app',
      grant_type: 'refresh_token',
      refresh_token: 'TG-viejo',
      test_token: false,
    });
    expect(grant).toMatchObject({ accessToken: 'APP_USR-nuevo', refreshToken: 'TG-nuevo', liveMode: false });
  });

  it('un código rechazado da un error con el motivo de Mercado Pago, sin el secreto', async () => {
    const promise = client(fakeFetch(400, { error: 'invalid_grant', message: 'invalid_grant', status: 400 })).exchangeCode({
      code: 'TG-vencido',
      redirectUri: 'https://x.test/cb',
    });

    await expect(promise).rejects.toThrow(MercadoPagoApiError);
    await expect(promise).rejects.toMatchObject({ status: 400, code: 'invalid_grant' });
    await expect(promise).rejects.not.toThrow(/secreto-app/);
  });
});

describe('createMercadoPagoClient: preferencia', () => {
  it('cobra la seña en la cuenta del negocio, en modo binario y sin efectivo (4.5)', async () => {
    const captured: Captured[] = [];
    const fetch = fakeFetch(201, { id: 'pref-1', init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-1' }, captured);

    const created = await client(fetch).createPreference({
      accessToken: TOKEN,
      preference: {
        depositId: '5f0c7c34-2f5e-4c1b-9d55-3a8d6f2b1c90',
        title: 'Seña: Esmaltado semipermanente',
        amountCents: 540_050,
        notificationUrl: 'https://x.test/webhooks/mercadopago/negocio',
        createdAt: new Date('2026-10-29T15:00:00Z'),
        expiresAt: new Date('2026-10-29T16:00:00Z'),
      },
    });

    expect(created).toEqual({
      preferenceId: 'pref-1',
      paymentUrl: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=pref-1',
    });
    const [request] = captured;
    expect(request?.url).toBe('https://api.mercadopago.com/checkout/preferences');
    expect(request?.init.method).toBe('POST');
    expect(new Headers(request?.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(bodyOf(request)).toEqual({
      items: [
        {
          id: '5f0c7c34-2f5e-4c1b-9d55-3a8d6f2b1c90',
          title: 'Seña: Esmaltado semipermanente',
          quantity: 1,
          currency_id: 'ARS',
          unit_price: 5400.5,
        },
      ],
      external_reference: '5f0c7c34-2f5e-4c1b-9d55-3a8d6f2b1c90',
      notification_url: 'https://x.test/webhooks/mercadopago/negocio',
      binary_mode: true,
      payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
      expires: true,
      expiration_date_from: '2026-10-29T15:00:00.000Z',
      expiration_date_to: '2026-10-29T16:00:00.000Z',
    });
  });

  it('un token vencido da un error con el estado', async () => {
    const promise = client(fakeFetch(401, { message: 'invalid access token', error: 'unauthorized', status: 401 })).createPreference({
      accessToken: TOKEN,
      preference: {
        depositId: 'd',
        title: 'Seña',
        amountCents: 100,
        notificationUrl: 'https://x.test/w',
        createdAt: new Date('2026-10-29T15:00:00Z'),
        expiresAt: new Date('2026-10-29T16:00:00Z'),
      },
    });

    await expect(promise).rejects.toMatchObject({ name: 'MercadoPagoApiError', status: 401 });
    await expect(promise).rejects.not.toThrow(new RegExp(TOKEN));
  });
});

describe('createMercadoPagoClient: pagos', () => {
  it('consulta el pago con el token del negocio', async () => {
    const captured: Captured[] = [];

    const payment = await client(fakeFetch(200, PAYMENT, captured)).getPayment({ accessToken: TOKEN, paymentId: '1234567890' });

    expect(captured[0]?.url).toBe('https://api.mercadopago.com/v1/payments/1234567890');
    expect(new Headers(captured[0]?.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(payment).toEqual({
      id: '1234567890',
      status: 'approved',
      externalReference: '5f0c7c34-2f5e-4c1b-9d55-3a8d6f2b1c90',
      amountCents: 540_000,
      currency: 'ARS',
    });
  });

  it('redondea el monto al centavo', async () => {
    const payment = await client(fakeFetch(200, { ...PAYMENT, transaction_amount: 5400.3 })).getPayment({
      accessToken: TOKEN,
      paymentId: '1',
    });

    expect(payment.amountCents).toBe(540_030);
  });

  it('un pago sin external_reference queda con null', async () => {
    const payment = await client(fakeFetch(200, { ...PAYMENT, external_reference: null })).getPayment({
      accessToken: TOKEN,
      paymentId: '1',
    });

    expect(payment.externalReference).toBeNull();
  });

  it('busca los pagos de una seña por su external_reference', async () => {
    const captured: Captured[] = [];

    const payments = await client(fakeFetch(200, { paging: { total: 1 }, results: [PAYMENT] }, captured)).searchPayments({
      accessToken: TOKEN,
      externalReference: 'seña 1',
    });

    expect(captured[0]?.url).toBe('https://api.mercadopago.com/v1/payments/search?external_reference=se%C3%B1a+1');
    expect(payments).toHaveLength(1);
  });

  it('un pago que no existe da un error 404', async () => {
    const promise = client(fakeFetch(404, { message: 'Payment not found', error: 'not_found', status: 404 })).getPayment({
      accessToken: TOKEN,
      paymentId: '9',
    });

    await expect(promise).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('una respuesta con otro formato da un error, no un pago a medias', async () => {
    const promise = client(fakeFetch(200, { id: 1 })).getPayment({ accessToken: TOKEN, paymentId: '1' });

    await expect(promise).rejects.toThrow(MercadoPagoApiError);
  });
});
