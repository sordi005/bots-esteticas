import { pino, type DestinationStream, type Logger } from 'pino';
import type { Config } from './config.js';

interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

/**
 * Cómo se loguea cada pedido. Sin headers (pueden traer tokens) y sin query string: la
 * verificación del webhook de Meta, por ejemplo, manda el token de verificación en la URL.
 */
function serializeRequest(request: LoggedRequest) {
  return {
    method: request.method,
    url: request.url?.split('?')[0],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/**
 * Logs en JSON. Nunca se loguean credenciales (ver sección 10.1 de la especificación).
 * `destination` es para los tests; por defecto, la salida estándar.
 */
export function createLogger(config: Pick<Config, 'logLevel'>, destination?: DestinationStream): Logger {
  return pino({ level: config.logLevel, serializers: { req: serializeRequest } }, destination);
}
