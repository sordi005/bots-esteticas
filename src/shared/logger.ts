import { DrizzleQueryError } from 'drizzle-orm';
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
 * Los campos de un error que van al log, además del tipo, el mensaje y el stack: códigos y nombres,
 * nunca valores. Es una lista blanca a propósito: `pg` pone en `detail`, `where` e `internalQuery`
 * los valores de la fila (el teléfono o el nombre de una clienta), el SDK de Anthropic guarda el
 * cuerpo y los headers de la respuesta, y un error nuevo de cualquier librería puede traer más.
 */
const SAFE_ERROR_FIELDS = [
  'code',
  'status',
  'severity',
  'schema',
  'table',
  'column',
  'constraint',
  'routine',
  'reason',
  'requestID',
] as const;

/** Hasta dónde se siguen las causas: corta una cadena circular. */
const MAX_ERROR_DEPTH = 5;

export interface SerializedError {
  type: string;
  message: string;
  stack: string;
  cause?: unknown;
  errors?: unknown[];
  [field: string]: unknown;
}

/**
 * Cómo se loguea un error (10.1 y regla 8). Drizzle arma el mensaje con la consulta y sus
 * parámetros (`Failed query: … params: …`), que traen el texto de los mensajes, teléfonos y
 * nombres: de ese error queda solo `Failed query` y el error de Postgres de la causa. El stack se
 * rearma con el mensaje limpio, porque su primera línea repite el mensaje original.
 */
export function serializeError(value: Error): SerializedError;
export function serializeError(value: unknown): unknown;
export function serializeError(value: unknown): unknown {
  return serializeAtDepth(value, 0);
}

function serializeAtDepth(value: unknown, depth: number): unknown {
  if (!(value instanceof Error)) return value;

  const type = value.constructor.name || value.name;
  const message = value instanceof DrizzleQueryError ? 'Failed query' : value.message;
  const frames = (value.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
  const serialized: SerializedError = { type, message, stack: [`${type}: ${message}`, ...frames].join('\n') };

  const fields = value as unknown as Record<string, unknown>;
  for (const field of SAFE_ERROR_FIELDS) {
    if (fields[field] !== undefined && fields[field] !== null) serialized[field] = fields[field];
  }

  if (depth < MAX_ERROR_DEPTH) {
    if (value.cause !== undefined) serialized.cause = serializeAtDepth(value.cause, depth + 1);
    if (value instanceof AggregateError) {
      serialized.errors = (value.errors as unknown[]).map((error) => serializeAtDepth(error, depth + 1));
    }
  }
  return serialized;
}

/**
 * Logs en JSON. Nunca se loguean credenciales ni datos de las clientas (ver sección 10.1 de la
 * especificación). `destination` es para los tests; por defecto, la salida estándar.
 */
export function createLogger(config: Pick<Config, 'logLevel'>, destination?: DestinationStream): Logger {
  return pino({ level: config.logLevel, serializers: { req: serializeRequest, err: serializeError } }, destination);
}
