import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  databaseUrl: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Valida las variables de entorno al arrancar: si falta algo, el proceso
 * no levanta (mejor fallar enseguida que a mitad de una conversación).
 * El mensaje de error nunca incluye los valores, que pueden ser secretos.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Configuración inválida:\n${z.prettifyError(result.error)}`);
  }

  const { NODE_ENV, HOST, PORT, LOG_LEVEL, DATABASE_URL } = result.data;
  return {
    nodeEnv: NODE_ENV,
    host: HOST,
    port: PORT,
    logLevel: LOG_LEVEL,
    databaseUrl: DATABASE_URL,
  };
}
