import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MercadoPagoClient, MercadoPagoPayment, PreferenceInput } from '../../../src/modules/mercadopago/client.js';
import type { ToolContext } from '../../../src/modules/conversation/tools/tool.js';
import { saveCredential } from '../../../src/modules/tenants/credentials.js';
import { createLogger } from '../../../src/shared/logger.js';

export const PUBLIC_BASE_URL = 'https://ejemplo.ngrok-free.dev';
export const MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-del-negocio';

export const paymentUrl = (preferenceId: string) =>
  `https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=${preferenceId}`;

/**
 * Un cliente de Mercado Pago sin red. Las preferencias se numeran (`pref-1`, `pref-2`…); `payments`
 * son los pagos que conoce la API, por id. `fail` hace fallar cada pedido con ese error.
 */
export function fakeMercadoPago(options: { fail?: Error; payments?: MercadoPagoPayment[] } = {}) {
  const created: { accessToken: string; preference: PreferenceInput }[] = [];
  const consulted: { accessToken: string; paymentId?: string; externalReference?: string }[] = [];
  const payments = options.payments ?? [];
  const unused = () => Promise.reject(new Error('No se usa en estos tests'));
  const client: MercadoPagoClient = {
    exchangeCode: unused,
    refreshToken: unused,
    createPreference: (input) => {
      if (options.fail) return Promise.reject(options.fail);
      created.push(input);
      const preferenceId = `pref-${String(created.length)}`;
      return Promise.resolve({ preferenceId, paymentUrl: paymentUrl(preferenceId) });
    },
    getPayment: ({ accessToken, paymentId }) => {
      consulted.push({ accessToken, paymentId });
      if (options.fail) return Promise.reject(options.fail);
      const payment = payments.find((candidate) => candidate.id === paymentId);
      return payment ? Promise.resolve(payment) : Promise.reject(new Error(`No existe el pago ${paymentId}`));
    },
    searchPayments: ({ accessToken, externalReference }) => {
      consulted.push({ accessToken, externalReference });
      if (options.fail) return Promise.reject(options.fail);
      return Promise.resolve(payments.filter((payment) => payment.externalReference === externalReference));
    },
  };
  return { client, created, consulted, payments };
}

/** Deja al negocio con su cuenta de Mercado Pago conectada (los tokens, cifrados). */
export async function connectMercadoPago(db: NodePgDatabase, key: Buffer, tenantId: string): Promise<void> {
  await saveCredential(db, key, {
    tenantId,
    kind: 'mercadopago',
    value: { accessToken: MERCADOPAGO_ACCESS_TOKEN, refreshToken: 'TG-renovacion', userId: '241983636', liveMode: false },
  });
}

/** Lo que el servidor le pasa a las herramientas para cobrar con Mercado Pago. */
export function toolMercadoPago(client: MercadoPagoClient, credentialsKey: Buffer): NonNullable<ToolContext['mercadoPago']> {
  return { client, credentialsKey, publicBaseUrl: PUBLIC_BASE_URL, logger: createLogger({ logLevel: 'silent' }) };
}
