import * as Sentry from '@sentry/node';
import type { ErrorEvent, NodeOptions } from '@sentry/node';

/**
 * Sentry (10.2, decisión 54): solo errores, sin medición de rendimiento ni instrumentación automática
 * (la integración de Fastify no documenta Fastify 5). Se inicializa en main.ts, sin `--import`: los
 * errores se mandan a mano (`captureException`, `raiseAlert`), así que no hace falta cargar nada antes.
 */
export function sentryOptions(input: { dsn: string; environment: string }): NodeOptions {
  return {
    dsn: input.dsn,
    environment: input.environment,
    // Nada automático: ni pedidos HTTP, ni consola, ni manejadores globales (los pone main.ts).
    defaultIntegrations: false,
    // Las causas de un error (`cause`), como el error de Postgres debajo del de Drizzle.
    integrations: [Sentry.linkedErrorsIntegration()],
    beforeSend: scrubEvent,
  };
}

/** Drizzle arma el mensaje con la consulta y sus parámetros: datos de las clientas (10.1). */
const DRIZZLE_QUERY_MESSAGE = 'Failed query';

/**
 * Lo que nunca sale hacia Sentry (9.2): el pedido (el cuerpo del webhook trae los mensajes, la query
 * el token de verificación de Meta), el usuario y las migas. Los mensajes de error pasan por el mismo
 * filtro que los logs.
 */
function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  for (const value of event.exception?.values ?? []) {
    if (value.value?.startsWith(DRIZZLE_QUERY_MESSAGE)) value.value = DRIZZLE_QUERY_MESSAGE;
  }
  return event;
}

export function initSentry(input: { dsn: string; environment: string }): void {
  Sentry.init(sentryOptions(input));
}

/** Manda un error a Sentry. Sin `initSentry` (sin DSN) no hace nada. */
export function reportException(error: unknown): void {
  Sentry.captureException(error);
}

/** Espera a que salga lo pendiente hacia Sentry, con un límite: se usa antes de terminar el proceso. */
export function flushSentry(timeoutMs = 2_000): Promise<boolean> {
  return Sentry.flush(timeoutMs);
}
