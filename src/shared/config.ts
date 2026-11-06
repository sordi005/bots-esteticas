import { createPrivateKey } from 'node:crypto';
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

const serviceAccountFields = z.object({ client_email: z.email(), private_key: z.string().min(1) });

/**
 * La clave de la cuenta de servicio de Google (8.4): el JSON que descarga Google, en base64. Los
 * mensajes de error nunca muestran su contenido.
 */
const googleServiceAccountKey = z.string().transform((value, context) => {
  let fields: z.infer<typeof serviceAccountFields>;
  try {
    const parsed = serviceAccountFields.safeParse(JSON.parse(Buffer.from(value, 'base64').toString('utf8')));
    if (!parsed.success) {
      context.addIssue({ code: 'custom', message: 'Al JSON de la cuenta de servicio le falta client_email o private_key' });
      return z.NEVER;
    }
    fields = parsed.data;
  } catch {
    context.addIssue({ code: 'custom', message: 'Tiene que ser el JSON de la cuenta de servicio, en base64' });
    return z.NEVER;
  }
  try {
    createPrivateKey(fields.private_key);
  } catch {
    context.addIssue({ code: 'custom', message: 'La clave privada de la cuenta de servicio no sirve para firmar' });
    return z.NEVER;
  }
  return { clientEmail: fields.client_email, privateKey: fields.private_key };
});

/** Obligatorias en producción; en desarrollo se puede trabajar sin Meta configurado. */
const REQUIRED_IN_PRODUCTION = [
  'CREDENTIALS_ENCRYPTION_KEY',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  // Desde H8 producción procesa conversaciones (6.7): sin la clave del modelo no tiene sentido arrancar.
  'ANTHROPIC_API_KEY',
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
    /**
     * SOLO desarrollo (8.1, H10): manda con plantilla todo aviso que la tenga, sin probar antes el
     * mensaje libre. En la demo la dueña y la clienta son el mismo celular y el 131047 nunca se da solo.
     */
    WHATSAPP_PREFER_TEMPLATES: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    ),
    /**
     * Número de avisos del servicio (8.2): de ahí salen los avisos a las dueñas. Es del servicio, no
     * de un negocio. Sin configurar, salen del número de cada negocio (la demo de la fase 0).
     */
    NOTIFICATIONS_PHONE_NUMBER_ID: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().regex(/^\d+$/, 'Solo dígitos, como lo da Meta').optional(),
    ),
    NOTIFICATIONS_ACCESS_TOKEN: optionalSecret,
    /** Clave de la API de Claude (sección 8.5). Secreta: nunca en logs. */
    ANTHROPIC_API_KEY: optionalSecret,
    ANTHROPIC_MODEL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().trim().min(1).default(DEFAULT_ANTHROPIC_MODEL),
    ),
    /** La aplicación del servicio en Mercado Pago (8.3): una sola para todos los negocios. */
    MERCADOPAGO_CLIENT_ID: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().regex(/^\d+$/, 'Solo dígitos, como lo da Mercado Pago').optional(),
    ),
    MERCADOPAGO_CLIENT_SECRET: optionalSecret,
    /** La clave secreta de Webhooks de la aplicación: valida la firma de los avisos (8.3). */
    MERCADOPAGO_WEBHOOK_SECRET: optionalSecret,
    /** SOLO desarrollo (8.3): tokens de las cuentas de prueba de Mercado Pago. */
    MERCADOPAGO_TEST_TOKEN: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    ),
    /** La cuenta de servicio de Google Calendar (8.4): una sola para todos los negocios. */
    GOOGLE_SERVICE_ACCOUNT_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      googleServiceAccountKey.optional(),
    ),
    /** Dónde nos encuentra Mercado Pago: la vuelta de OAuth y los avisos de pago (8.3). */
    PUBLIC_BASE_URL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .url({ protocol: /^https$/, error: 'Tiene que ser una URL https' })
        .transform((value) => value.replace(/\/+$/, ''))
        .optional(),
    ),
  })
  .superRefine((env, context) => {
    const mercadoPagoVariables = [
      'MERCADOPAGO_CLIENT_ID',
      'MERCADOPAGO_CLIENT_SECRET',
      'MERCADOPAGO_WEBHOOK_SECRET',
      'PUBLIC_BASE_URL',
    ] as const;
    if (mercadoPagoVariables.some((name) => env[name])) {
      for (const name of mercadoPagoVariables) {
        if (!env[name]) {
          context.addIssue({
            code: 'custom',
            path: [name],
            message: 'Mercado Pago se configura completo: la aplicación, su clave de Webhooks y la URL pública',
          });
        }
      }
    }
    if (Boolean(env.WHATSAPP_APP_SECRET) !== Boolean(env.WHATSAPP_VERIFY_TOKEN)) {
      context.addIssue({
        code: 'custom',
        path: [env.WHATSAPP_APP_SECRET ? 'WHATSAPP_VERIFY_TOKEN' : 'WHATSAPP_APP_SECRET'],
        message: 'El secreto de la app y el token de verificación se configuran juntos',
      });
    }
    if (Boolean(env.NOTIFICATIONS_PHONE_NUMBER_ID) !== Boolean(env.NOTIFICATIONS_ACCESS_TOKEN)) {
      context.addIssue({
        code: 'custom',
        path: [env.NOTIFICATIONS_PHONE_NUMBER_ID ? 'NOTIFICATIONS_ACCESS_TOKEN' : 'NOTIFICATIONS_PHONE_NUMBER_ID'],
        message: 'El número de avisos y su token se configuran juntos',
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
    if (env.WHATSAPP_PREFER_TEMPLATES) {
      context.addIssue({
        code: 'custom',
        path: ['WHATSAPP_PREFER_TEMPLATES'],
        message: 'Es solo para la prueba manual: en producción los avisos prueban primero el mensaje libre',
      });
    }
    if (env.MERCADOPAGO_TEST_TOKEN) {
      context.addIssue({
        code: 'custom',
        path: ['MERCADOPAGO_TEST_TOKEN'],
        message: 'Es solo para desarrollo: en producción cobraría con las cuentas de prueba',
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
  /** Solo en desarrollo: los avisos salen directo con su plantilla (8.1, H10). */
  preferTemplates: boolean;
  /** Null: los avisos a la dueña salen del número de cada negocio (fase 0, sección 8.2). */
  notificationsNumber: { phoneNumberId: string; accessToken: string } | null;
  /** Null: sin clave el worker no contesta conversaciones (sección 8.5). En producción es obligatoria. */
  anthropicApiKey: string | null;
  anthropicModel: string;
  /** Null: sin la aplicación de Mercado Pago no se conecta ningún negocio ni se registra el webhook (8.3). */
  mercadoPago: {
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
    /** Sin barra final. */
    publicBaseUrl: string;
    testToken: boolean;
  } | null;
  /** La cuenta de servicio de Google Calendar (8.4). Sin ella, el calendario queda apagado. */
  googleServiceAccount: GoogleServiceAccount | null;
}

export interface GoogleServiceAccount {
  clientEmail: string;
  /** PEM. Secreta: nunca en logs. */
  privateKey: string;
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
    preferTemplates: data.WHATSAPP_PREFER_TEMPLATES,
    notificationsNumber:
      data.NOTIFICATIONS_PHONE_NUMBER_ID && data.NOTIFICATIONS_ACCESS_TOKEN
        ? { phoneNumberId: data.NOTIFICATIONS_PHONE_NUMBER_ID, accessToken: data.NOTIFICATIONS_ACCESS_TOKEN }
        : null,
    anthropicApiKey: data.ANTHROPIC_API_KEY ?? null,
    anthropicModel: data.ANTHROPIC_MODEL,
    mercadoPago:
      data.MERCADOPAGO_CLIENT_ID && data.MERCADOPAGO_CLIENT_SECRET && data.MERCADOPAGO_WEBHOOK_SECRET && data.PUBLIC_BASE_URL
        ? {
            clientId: data.MERCADOPAGO_CLIENT_ID,
            clientSecret: data.MERCADOPAGO_CLIENT_SECRET,
            webhookSecret: data.MERCADOPAGO_WEBHOOK_SECRET,
            publicBaseUrl: data.PUBLIC_BASE_URL,
            testToken: data.MERCADOPAGO_TEST_TOKEN,
          }
        : null,
    googleServiceAccount: data.GOOGLE_SERVICE_ACCOUNT_KEY ?? null,
  };
}
