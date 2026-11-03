import { z } from 'zod';

/**
 * Cliente de la API de Mercado Pago (8.3), con `fetch` y Zod en vez del SDK (decisión 39). Recibe
 * `fetch` por parámetro para probarlo sin red. Ni los tokens ni el secreto de la aplicación
 * aparecen en los errores ni en los logs. Formatos de mercadopago.com.ar/developers/es/reference.
 */
export class MercadoPagoApiError extends Error {
  override name = 'MercadoPagoApiError';
  readonly status: number;
  /** El código de error de Mercado Pago, por ejemplo `invalid_grant`. */
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Lo que devuelve Mercado Pago al canjear un código o renovar el token. */
export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  /** La cuenta de Mercado Pago que autorizó. */
  userId: string;
  liveMode: boolean;
}

export interface PreferenceInput {
  /** Va como `external_reference` (4.5): así el pago dice de qué seña es. */
  depositId: string;
  title: string;
  amountCents: number;
  notificationUrl: string;
  createdAt: Date;
  /** El vencimiento de la seña: después, el link ya no cobra. */
  expiresAt: Date;
}

export interface MercadoPagoPayment {
  id: string;
  status: string;
  externalReference: string | null;
  amountCents: number;
  currency: string;
}

export interface MercadoPagoClient {
  exchangeCode(input: { code: string; redirectUri: string }): Promise<TokenGrant>;
  refreshToken(input: { refreshToken: string }): Promise<TokenGrant>;
  createPreference(input: { accessToken: string; preference: PreferenceInput }): Promise<{
    preferenceId: string;
    paymentUrl: string;
  }>;
  getPayment(input: { accessToken: string; paymentId: string }): Promise<MercadoPagoPayment>;
  searchPayments(input: { accessToken: string; externalReference: string }): Promise<MercadoPagoPayment[]>;
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  user_id: z.union([z.number(), z.string()]).transform(String),
  live_mode: z.boolean(),
});

const preferenceResponse = z.object({ id: z.string().min(1), init_point: z.url() });

// El ejemplo oficial trae el monto como texto ("24.50"); la API real, como número.
const amount = z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/).transform(Number)]);

const paymentResponse = z
  .object({
    id: z.union([z.number(), z.string()]).transform(String),
    status: z.string().min(1),
    external_reference: z.string().nullish(),
    transaction_amount: amount,
    currency_id: z.string().min(1),
  })
  .transform(
    (payment): MercadoPagoPayment => ({
      id: payment.id,
      status: payment.status,
      externalReference: payment.external_reference ?? null,
      amountCents: Math.round(payment.transaction_amount * 100),
      currency: payment.currency_id,
    }),
  );

const searchResponse = z.object({ results: z.array(paymentResponse) });

const errorResponse = z.object({ error: z.string().optional(), message: z.string().optional() });

function apiError(action: string, status: number, body: unknown): MercadoPagoApiError {
  const error = errorResponse.safeParse(body);
  const detail = error.success ? (error.data.message ?? error.data.error) : undefined;
  return new MercadoPagoApiError(
    detail ? `Mercado Pago rechazó ${action}: ${detail}` : `Mercado Pago respondió ${String(status)} a ${action}`,
    status,
    error.success ? (error.data.error ?? null) : null,
  );
}

export function createMercadoPagoClient(options: {
  clientId: string;
  clientSecret: string;
  /** Solo desarrollo: tokens de las cuentas de prueba (8.3). */
  testToken: boolean;
  fetch?: typeof fetch;
  baseUrl?: string;
}): MercadoPagoClient {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? 'https://api.mercadopago.com';

  async function call<T>(
    action: string,
    path: string,
    init: { method?: 'GET' | 'POST'; accessToken?: string; body?: unknown },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await request(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.accessToken ? { authorization: `Bearer ${init.accessToken}` } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw apiError(action, response.status, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new MercadoPagoApiError(`Mercado Pago devolvió ${action} con otro formato`, response.status, null);
    }
    return parsed.data;
  }

  async function token(body: Record<string, string>): Promise<TokenGrant> {
    const grant = await call(
      'el token',
      '/oauth/token',
      {
        method: 'POST',
        body: { client_id: options.clientId, client_secret: options.clientSecret, ...body, test_token: options.testToken },
      },
      tokenResponse,
    );
    return {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      expiresInSeconds: grant.expires_in,
      userId: grant.user_id,
      liveMode: grant.live_mode,
    };
  }

  return {
    exchangeCode: ({ code, redirectUri }) =>
      token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),

    refreshToken: ({ refreshToken }) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),

    async createPreference({ accessToken, preference }) {
      const created = await call(
        'la preferencia',
        '/checkout/preferences',
        {
          method: 'POST',
          accessToken,
          body: {
            items: [
              {
                id: preference.depositId,
                title: preference.title,
                quantity: 1,
                currency_id: 'ARS',
                unit_price: preference.amountCents / 100,
              },
            ],
            external_reference: preference.depositId,
            notification_url: preference.notificationUrl,
            // Aprobado o rechazado, nunca pendiente; sin efectivo, que tarda horas o días (4.5).
            binary_mode: true,
            payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
            expires: true,
            expiration_date_from: preference.createdAt.toISOString(),
            expiration_date_to: preference.expiresAt.toISOString(),
          },
        },
        preferenceResponse,
      );
      return { preferenceId: created.id, paymentUrl: created.init_point };
    },

    getPayment: ({ accessToken, paymentId }) =>
      call('el pago', `/v1/payments/${encodeURIComponent(paymentId)}`, { accessToken }, paymentResponse),

    async searchPayments({ accessToken, externalReference }) {
      const query = new URLSearchParams({ external_reference: externalReference });
      const found = await call('la búsqueda de pagos', `/v1/payments/search?${query.toString()}`, { accessToken }, searchResponse);
      return found.results;
    },
  };
}
