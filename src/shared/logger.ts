import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

/** Logs en JSON. Nunca se loguean credenciales (ver sección 10.1 de la especificación). */
export function createLogger(config: Pick<Config, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      censor: '[redactado]',
    },
  });
}
