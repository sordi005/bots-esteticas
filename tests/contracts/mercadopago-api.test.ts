import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createMercadoPagoClient } from '../../src/modules/mercadopago/client.js';
import { parseMercadoPagoNotification } from '../../src/modules/mercadopago/notification.js';

/**
 * Contratos con Mercado Pago (sección 11.3): los archivos de `mercadopago/` son los ejemplos
 * oficiales de mercadopago.com.ar/developers (referencia de OAuth, de Checkout Pro y la guía de
 * notificaciones), copiados tal cual. Si Mercado Pago cambia el formato, se agrega el ejemplo
 * nuevo y el parser se adapta.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`mercadopago/${name}.json`, import.meta.url), 'utf8'));
}

const respondWith = (body: unknown): typeof fetch => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

const clientFor = (name: string) =>
  createMercadoPagoClient({
    clientId: '4934588586838432',
    clientSecret: 'secreto',
    testToken: false,
    fetch: respondWith(fixture(name)),
  });

describe('POST /oauth/token', () => {
  it('lee los tokens, su duración y la cuenta que autorizó', async () => {
    const grant = await clientFor('oauth-token').exchangeCode({ code: 'TG-codigo', redirectUri: 'https://x.test/cb' });

    expect(grant).toEqual({
      accessToken: 'APP_USR-4934588586838432-XXXXXXXX-241983636',
      refreshToken: 'TG-XXXXXXXX-241983636',
      expiresInSeconds: 15_552_000,
      userId: '241983636',
      liveMode: true,
    });
  });
});

describe('POST /checkout/preferences', () => {
  it('lee el id de la preferencia y el link de pago', async () => {
    const created = await clientFor('preference-created').createPreference({
      accessToken: 'APP_USR-token',
      preference: {
        depositId: '5f0c7c34-2f5e-4c1b-9d55-3a8d6f2b1c90',
        title: 'Seña: Esmaltado semipermanente',
        amountCents: 540_000,
        notificationUrl: 'https://x.test/webhooks/mercadopago/negocio',
        createdAt: new Date('2026-10-29T15:00:00Z'),
        expiresAt: new Date('2026-10-29T16:00:00Z'),
      },
    });

    expect(created).toEqual({
      preferenceId: '202809963-920c288b-4ebb-40be-966f-700250fa5370',
      paymentUrl: 'https://www.mercadopago.com/mla/checkout/start?pref_id=202809963-920c288b-4ebb-40be-966f-700250fa5370',
    });
  });
});

describe('GET /v1/payments/{id}', () => {
  it('lee el estado, la seña a la que se refiere, el monto en centavos y la moneda', async () => {
    const payment = await clientFor('payment').getPayment({ accessToken: 'APP_USR-token', paymentId: '1' });

    // El ejemplo oficial trae el monto como texto ("24.50"): se acepta como número o como texto.
    expect(payment).toEqual({
      id: '1',
      status: 'approved',
      externalReference: 'MP0001',
      amountCents: 2450,
      currency: 'ARS',
    });
  });
});

describe('GET /v1/payments/search', () => {
  it('lee cada pago encontrado', async () => {
    const payments = await clientFor('payments-search').searchPayments({
      accessToken: 'APP_USR-token',
      externalReference: 'MP0001',
    });

    expect(payments).toEqual([
      { id: '1', status: 'approved', externalReference: 'MP0001', amountCents: 2450, currency: 'ARS' },
    ]);
  });
});

describe('aviso de webhook', () => {
  it('un aviso de pago trae el id del pago', () => {
    expect(parseMercadoPagoNotification({ type: 'payment', 'data.id': '123456' }, fixture('webhook-payment'))).toEqual({
      kind: 'payment',
      paymentId: '123456',
    });
  });
});
