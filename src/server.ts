import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { mercadoPagoRoutes, type MercadoPagoRoutesOptions } from './modules/mercadopago/routes.js';
import {
  whatsappWebhookRoutes,
  type WhatsAppWebhookOptions,
} from './modules/whatsapp/webhook-routes.js';
import { runHealthChecks, type HealthCheck } from './shared/health.js';

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000;

export interface ServerDependencies {
  healthChecks: Record<string, HealthCheck>;
  healthCheckTimeoutMs?: number;
  /** Sin logger, Fastify no loguea (útil en tests). */
  logger?: FastifyBaseLogger;
  /** Sin la app de Meta configurada, el webhook de WhatsApp no se registra. */
  whatsappWebhook?: WhatsAppWebhookOptions;
  /** Sin la aplicación de Mercado Pago configurada, la vuelta de OAuth y su webhook no se registran. */
  mercadoPago?: MercadoPagoRoutesOptions;
  /** Recibe cada error `5xx` de una ruta: un bug (10.2). main.ts lo manda a Sentry. */
  reportError?: (error: unknown) => void;
}

/** Arma Fastify y registra las rutas. No escucha en ningún puerto: eso lo hace main.ts. */
export function buildServer(dependencies: ServerDependencies): FastifyInstance {
  const server = Fastify(dependencies.logger ? { loggerInstance: dependencies.logger } : {});

  // Sin la integración de Sentry para Fastify (decisión 54): los 5xx se reportan acá. Un 4xx es un
  // pedido mal armado, no un bug. La respuesta es la de Fastify; el log, el mismo que el suyo.
  server.setErrorHandler((error, request, reply) => {
    const statusCode = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (statusCode >= 400 && statusCode < 500) {
      request.log.info({ err: error }, 'Pedido rechazado');
    } else {
      request.log.error({ err: error }, 'Error inesperado en una ruta');
      dependencies.reportError?.(error);
    }
    return reply.send(error);
  });

  // El monitor externo consulta /health seguido: solo se loguean advertencias y errores.
  server.get('/health', { logLevel: 'warn' }, async (request, reply) => {
    const report = await runHealthChecks(dependencies.healthChecks, {
      timeoutMs: dependencies.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
      onFailure: (check, error) => {
        request.log.error({ err: error, check }, 'Falló un chequeo de salud');
      },
    });

    return reply.code(report.status === 'ok' ? 200 : 503).send(report);
  });

  if (dependencies.whatsappWebhook) {
    void server.register(whatsappWebhookRoutes, dependencies.whatsappWebhook);
  }
  if (dependencies.mercadoPago) {
    void server.register(mercadoPagoRoutes, dependencies.mercadoPago);
  }

  return server;
}
