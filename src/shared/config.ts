import { z } from 'zod';
import { parseEncryptionKey } from './encryption.js';

/** En .env, una variable vacía es lo mismo que no definida. */
/** Modelo de IA por defecto (sección 8.5): chico y barato. Las evaluaciones deciden si hace falta subir. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';

/** Versión de la Graph API de Meta (sección 8.1). Revisar su registro de cambios antes de subirla. */
export const DEFAULT_GRAPH_API_VERSION = 'v26.0';

const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

function decodesToKey(value: string): boolean {
  try {
    parseEncryptionKey(value);
    return true;
  } catch {
    return false;
  }
}

/** Obligatorias en producción; en desarrollo se puede trabajar sin Meta configurado. */
const REQUIRED_IN_PRODUCTION = [
  'CREDENTIALS_ENCRYPTION_KEY',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
] as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Cifra las credenciales de terceros en la base (sección 9.1). 32 bytes en base64. */
    CREDENTIALS_ENCRYPTION_KEY: optionalSecret.refine(
      (value) => value === undefined || decodesToKey(value),
      'Tiene que ser una clave de 32 bytes en base64',
    ),
    /** App Secret de la app de Meta: valida la firma de los webhooks. */
    WHATSAPP_APP_SECRET: optionalSecret,
    /** Lo elegimos nosotros y se carga en Meta al registrar el webhook. */
    WHATSAPP_VERIFY_TOKEN: optionalSecret,
    WHATSAPP_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default(DEFAULT_GRAPH_API_VERSION),
    /**
     * SOLO desarrollo: el número de prueba de Meta solo contesta a los de su lista, que
     * guarda los celulares argentinos con el 15 (sección 8.1). Todo envío va a este número.
     */
    WHATSAPP_TEST_RECIPIENT: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^[1-9][0-9]{7,14}$/, 'Solo dígitos, como figura en la lista de prueba de Meta')
        .optional(),
    ),
    /** Clave de la API de Claude (sección 8.5). Secreta: nunca en logs. */
    ANTHROPIC_API_KEY: optionalSecret,
    ANTHROPIC_MODEL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().trim().min(1).default(DEFAULT_ANTHROPIC_MODEL),
    ),
  })
  .superRefine((env, context) => {
    if (Boolean(env.WHATSAPP_APP_SECRET) !== Boolean(env.WHATSAPP_VERIFY_TOKEN)) {
      context.addIssue({
        code: 'custom',
        path: [env.WHATSAPP_APP_SECRET ? 'WHATSAPP_VERIFY_TOKEN' : 'WHATSAPP_APP_SECRET'],
        message: 'El secreto de la app y el token de verificación se configuran juntos',
      });
    }
    if (env.NODE_ENV !== 'production') return;

    if (env.WHATSAPP_TEST_RECIPIENT) {
      context.addIssue({
        code: 'custom',
        path: ['WHATSAPP_TEST_RECIPIENT'],
        message: 'Es solo para desarrollo: en producción mandaría todo a un solo número',
      });
    }
    for (const name of REQUIRED_IN_PRODUCTION) {
      if (!env[name]) {
        context.addIssue({ code: 'custom', path: [name], message: 'Obligatoria en producción' });
      }
    }
    const key = env.CREDENTIALS_ENCRYPTION_KEY;
    if (key && decodesToKey(key) && parseEncryptionKey(key).every((byte) => byte === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['CREDENTIALS_ENCRYPTION_KEY'],
        message: 'La clave de ejemplo de .env.example no se usa en producción',
      });
    }
  });

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  databaseUrl: string;
  /** Null: sin clave no se pueden guardar ni leer credenciales de terceros. */
  credentialsKey: Buffer | null;
  /** Null: sin la app de Meta configurada, el webhook de WhatsApp no se registra. */
  whatsapp: { appSecret: string; verifyToken: string; graphApiVersion: string } | null;
  /** Solo en desarrollo: todo envío de WhatsApp va a este número (sección 8.1). */
  whatsappTestRecipient: string | null;
  /** Null: sin clave el worker no contesta conversaciones (sección 8.5). */
  anthropicApiKey: string | null;
  anthropicModel: string;
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

  const data = result.data;
  return {
    nodeEnv: data.NODE_ENV,
    host: data.HOST,
    port: data.PORT,
    logLevel: data.LOG_LEVEL,
    databaseUrl: data.DATABASE_URL,
    credentialsKey: data.CREDENTIALS_ENCRYPTION_KEY
      ? parseEncryptionKey(data.CREDENTIALS_ENCRYPTION_KEY)
      : null,
    whatsapp:
      data.WHATSAPP_APP_SECRET && data.WHATSAPP_VERIFY_TOKEN
        ? {
            appSecret: data.WHATSAPP_APP_SECRET,
            verifyToken: data.WHATSAPP_VERIFY_TOKEN,
            graphApiVersion: data.WHATSAPP_GRAPH_API_VERSION,
          }
        : null,
    whatsappTestRecipient: data.WHATSAPP_TEST_RECIPIENT ?? null,
    anthropicApiKey: data.ANTHROPIC_API_KEY ?? null,
    anthropicModel: data.ANTHROPIC_MODEL,
  };
}
