import { raiseAlert } from '../shared/alerts.js';
import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { flushSentry, initSentry } from '../shared/sentry.js';

/**
 * Levanta una alerta de prueba (10.3): es el criterio de terminado de H14. Uso: `pnpm alert:test`.
 *
 * Lleva la hora en la huella, así que cada corrida es un issue nuevo en Sentry y manda su email.
 * Necesita SENTRY_DSN: sin ella la alerta quedaría solo en el log.
 */
const config = loadConfig(process.env);
const logger = createLogger(config);

if (config.sentryDsn) {
  initSentry({ dsn: config.sentryDsn, environment: config.nodeEnv });
  const sentAt = new Date().toISOString();
  raiseAlert(logger, { kind: 'test', tenantId: null, detail: sentAt });

  if (await flushSentry(10_000)) {
    logger.info({ sentAt }, 'Alerta de prueba enviada a Sentry: en unos minutos tiene que llegar el email');
  } else {
    logger.error('No se pudo enviar la alerta de prueba a Sentry dentro de los 10 segundos');
    process.exitCode = 1;
  }
} else {
  logger.error('Falta SENTRY_DSN en .env: sin ella las alertas quedan solo en el log');
  process.exitCode = 1;
}
