import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { runHealthChecks, type HealthCheck } from './shared/health.js';

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000;

export interface ServerDependencies {
  healthChecks: Record<string, HealthCheck>;
  healthCheckTimeoutMs?: number;
  /** Sin logger, Fastify no loguea (útil en tests). */
  logger?: FastifyBaseLogger;
}

/** Arma Fastify y registra las rutas. No escucha en ningún puerto: eso lo hace main.ts. */
export function buildServer(dependencies: ServerDependencies): FastifyInstance {
  const server = Fastify(dependencies.logger ? { loggerInstance: dependencies.logger } : {});

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

  return server;
}
