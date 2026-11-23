import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { saveCredential } from '../modules/tenants/credentials.js';
import { tenants } from '../modules/tenants/schema.js';
import { COEXISTENCE_FIELDS, coexistenceStatus, type CoexistenceStatus } from '../modules/whatsapp/coexistence.js';
import { DEFAULT_GRAPH_API_VERSION, loadConfig } from '../shared/config.js';
import { createDatabase } from '../shared/db.js';
import { createLogger } from '../shared/logger.js';
import { isConstraintViolation, UNIQUE_VIOLATION } from '../shared/postgres-errors.js';

/**
 * Conecta un negocio a su número de WhatsApp: guarda el phone_number_id y el token de
 * acceso, cifrado. Uso: `pnpm whatsapp:connect <slug-del-negocio>`.
 *
 * El token se lee de WHATSAPP_ACCESS_TOKEN (en .env), nunca de un argumento: los argumentos
 * quedan en el historial de la terminal. Después de conectar, se puede borrar de .env.
 * Al terminar, pregunta a Meta si el número está en coexistencia (8.1, H13): sin ella no llegan ecos.
 * Cuando exista el panel de administración (H15), esto se hace desde ahí.
 */
const config = loadConfig(process.env);
const logger = createLogger(config);
const slug = process.argv[2];
const graphApiVersion = config.whatsapp?.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;

const COEXISTENCE_MESSAGES: Record<CoexistenceStatus, string> = {
  coexistence: 'Coexistencia activa: llegan los ecos de lo que la dueña escribe desde su app',
  api_only: 'El número no está en la app de WhatsApp Business: no van a llegar ecos y el asistente no sabrá cuándo escribe la dueña',
  not_connected: 'El número no está registrado en la Cloud API',
  unknown: 'Meta respondió algo inesperado al consultar la coexistencia',
};

async function fetchCoexistence(phoneNumberId: string, accessToken: string): Promise<CoexistenceStatus> {
  const response = await fetch(
    `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}?fields=${COEXISTENCE_FIELDS}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  return coexistenceStatus(await response.json().catch(() => null));
}
const input = z
  .object({
    WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/),
    WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  })
  .safeParse(process.env);

if (!slug || !input.success || !config.credentialsKey) {
  logger.error(
    'Uso: pnpm whatsapp:connect <slug-del-negocio>, con WHATSAPP_PHONE_NUMBER_ID, ' +
      'WHATSAPP_ACCESS_TOKEN y CREDENTIALS_ENCRYPTION_KEY definidas en .env',
  );
  process.exitCode = 1;
} else {
  const database = createDatabase(config.databaseUrl);
  const phoneNumberId = input.data.WHATSAPP_PHONE_NUMBER_ID;
  try {
    const [tenant] = await database.db
      .update(tenants)
      .set({ whatsappPhoneNumberId: phoneNumberId })
      .where(eq(tenants.slug, slug))
      .returning({ id: tenants.id });

    if (tenant) {
      await saveCredential(database.db, config.credentialsKey, {
        tenantId: tenant.id,
        kind: 'whatsapp',
        value: { accessToken: input.data.WHATSAPP_ACCESS_TOKEN },
      });
      logger.info({ tenant: slug, phoneNumberId }, 'WhatsApp conectado');

      // Solo informa: conectar no depende de que Meta conteste.
      const coexistence = await fetchCoexistence(phoneNumberId, input.data.WHATSAPP_ACCESS_TOKEN).catch(
        () => 'unknown' as const,
      );
      const level = coexistence === 'coexistence' ? 'info' : 'warn';
      logger[level]({ tenant: slug, phoneNumberId, coexistence }, COEXISTENCE_MESSAGES[coexistence]);
    } else {
      logger.error({ tenant: slug }, 'No existe un negocio con ese slug');
      process.exitCode = 1;
    }
  } catch (error) {
    if (isConstraintViolation(error, UNIQUE_VIOLATION, 'tenants_whatsapp_phone_number_id_unique')) {
      logger.error({ phoneNumberId }, 'Ese número de WhatsApp ya está conectado a otro negocio');
    } else {
      logger.fatal({ err: error }, 'No se pudo conectar WhatsApp');
    }
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
