import type { Logger } from 'pino';
import { createLogger } from '../../src/shared/logger.js';

export interface LogEntry {
  level: number;
  msg: string;
  [field: string]: unknown;
}

/** Un logger que guarda cada línea, para leer lo que se logueó y las alertas que se levantaron (10.3). */
export function captureLogs(): { logger: Logger; entries: () => LogEntry[]; alerts: () => LogEntry[] } {
  const lines: string[] = [];
  const logger = createLogger({ logLevel: 'debug' }, { write: (chunk: string) => void lines.push(chunk) });
  const entries = () => lines.map((line) => JSON.parse(line) as LogEntry);
  return { logger, entries, alerts: () => entries().filter((entry) => typeof entry.alert === 'string') };
}
