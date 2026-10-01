import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { isValidSignature } from './signature.js';
import { parseWebhook, type WebhookEvent } from './webhook-payload.js';

/**
 * Webhook de WhatsApp Cloud API (sección 6.5, CLAUDE.md regla 6): valida la firma, guarda
 * y responde 200 enseguida. El procesamiento (responder a la clienta) es del worker (H6).
 */
export interface WhatsAppWebhookOptions {
  appSecret: string;
  verifyToken: string;
  /** Guarda los eventos. Si falla, el webhook responde 500 y Meta reintenta: guardar es idempotente. */
  onEvents: (events: WebhookEvent[], log: FastifyBaseLogger) => Promise<void>;
}

const PATH = '/webhooks/whatsapp';

/** Compara en tiempo constante, aunque los textos tengan largos distintos. */
function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export const whatsappWebhookRoutes: FastifyPluginAsync<WhatsAppWebhookOptions> = (app, options) => {
  // La firma se calcula sobre los bytes tal como llegaron: en este plugin (y solo acá) el
  // JSON no se parsea automáticamente, llega como Buffer.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  // Meta lo llama una vez, al registrar el webhook en la app.
  app.get<{ Querystring: Record<string, string | undefined> }>(PATH, async (request, reply) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    if (mode === 'subscribe' && token && challenge && sameSecret(token, options.verifyToken)) {
      return reply.type('text/plain').send(challenge);
    }
    request.log.warn('Verificación del webhook de WhatsApp rechazada');
    return reply.code(403).send();
  });

  app.post(PATH, async (request, reply) => {
    const signatureHeader = request.headers['x-hub-signature-256'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const raw = request.body;

    if (!Buffer.isBuffer(raw) || !isValidSignature(raw, signature, options.appSecret)) {
      request.log.warn('Webhook de WhatsApp con firma inválida: descartado');
      return reply.code(401).send();
    }

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      request.log.warn('Webhook de WhatsApp firmado pero con JSON inválido');
      return reply.code(400).send();
    }

    const { events, ignored } = parseWebhook(body);
    if (ignored > 0) request.log.info({ ignored }, 'Cambios del webhook de WhatsApp ignorados');

    await options.onEvents(events, request.log);
    return reply.code(200).send();
  });

  return Promise.resolve();
};
