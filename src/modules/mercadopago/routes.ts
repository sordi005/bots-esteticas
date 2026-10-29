import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ConnectionResult } from './connection.js';
import { parseMercadoPagoNotification, type RecordedNotification } from './notification.js';
import { isValidMercadoPagoSignature } from './signature.js';

/**
 * Rutas de Mercado Pago (8.3): la vuelta de OAuth, que ve la dueña en el navegador, y el webhook de
 * pagos, que valida la firma, guarda y responde 200 (regla 6). Procesar el pago es del worker.
 */
export interface MercadoPagoRoutesOptions {
  /** La clave secreta de Webhooks de la aplicación. */
  webhookSecret: string;
  /** Canjea el código de la vuelta y guarda la cuenta del negocio. */
  connect: (input: { code: string; state: string }) => Promise<ConnectionResult>;
  /** Guarda el aviso de un pago. Si falla, responde 500 y Mercado Pago reintenta: guardar es idempotente. */
  onPayment: (input: { tenantId: string; paymentId: string }, log: FastifyBaseLogger) => Promise<RecordedNotification>;
}

export const OAUTH_CALLBACK_PATH = '/mercadopago/oauth/callback';

const callbackQuery = z.object({ code: z.string().min(1), state: z.string().min(1) });

/** Una página mínima para la dueña: está en el navegador, no en WhatsApp. */
function page(title: string, text: string): string {
  return (
    '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title></head>` +
    '<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">' +
    `<h1>${title}</h1><p>${text}</p></body></html>`
  );
}

const CONNECTED_PAGE = page('¡Listo!', 'Mercado Pago quedó conectado. Ya podés cerrar esta página.');
const RETRY_PAGE = page(
  'No se pudo conectar',
  'El link venció o ya se usó. Pedí un link nuevo y volvé a autorizar desde ahí.',
);

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export const mercadoPagoRoutes: FastifyPluginAsync<MercadoPagoRoutesOptions> = (app, options) => {
  app.get<{ Querystring: Record<string, string | undefined> }>(OAUTH_CALLBACK_PATH, async (request, reply) => {
    const query = callbackQuery.safeParse(request.query);
    if (!query.success) {
      request.log.warn('Vuelta de OAuth de Mercado Pago sin código o sin state');
      return reply.code(400).type('text/html').send(RETRY_PAGE);
    }

    const result = await options.connect(query.data);
    if (result.status !== 'connected') {
      request.log.warn({ status: result.status }, 'Vuelta de OAuth de Mercado Pago rechazada');
      return reply.code(400).type('text/html').send(RETRY_PAGE);
    }
    return reply.type('text/html').send(CONNECTED_PAGE);
  });

  app.post<{ Params: { tenantId: string }; Querystring: Record<string, string | undefined> }>(
    '/webhooks/mercadopago/:tenantId',
    async (request, reply) => {
      const { tenantId } = request.params;
      if (!z.uuid().safeParse(tenantId).success) return reply.code(404).send();

      const valid = isValidMercadoPagoSignature(
        {
          signature: header(request.headers['x-signature']),
          requestId: header(request.headers['x-request-id']),
          dataId: request.query['data.id'],
        },
        options.webhookSecret,
      );
      if (!valid) {
        request.log.warn({ tenantId }, 'Webhook de Mercado Pago con firma inválida: descartado');
        return reply.code(401).send();
      }

      const notification = parseMercadoPagoNotification(request.query, request.body);
      if (notification.kind === 'ignored') {
        request.log.info({ tenantId, type: notification.type }, 'Aviso de Mercado Pago ignorado');
        return reply.code(200).send();
      }

      const recorded = await options.onPayment({ tenantId, paymentId: notification.paymentId }, request.log);
      request.log[recorded === 'scheduled' ? 'info' : 'warn'](
        { tenantId, paymentId: notification.paymentId, recorded },
        'Aviso de pago de Mercado Pago guardado',
      );
      return reply.code(200).send();
    },
  );

  return Promise.resolve();
};
