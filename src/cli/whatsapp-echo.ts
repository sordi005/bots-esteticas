import { setTimeout as sleep } from 'node:timers/promises';
import { and, asc, eq, gt } from 'drizzle-orm';
import { sendWhatsAppMessage } from '../modules/conversation/outbox.js';
import { conversations, messages } from '../modules/conversation/schema.js';
import { tenants } from '../modules/tenants/schema.js';
import { createWhatsAppClient } from '../modules/whatsapp/client.js';
import { loadConfig } from '../shared/config.js';
import { createDatabase } from '../shared/db.js';
import { createLogger } from '../shared/logger.js';
import { echoReply } from './echo-reply.js';

/**
 * Herramienta de DESARROLLO para el criterio de H5: contesta cada mensaje que llega al
 * número de prueba de Meta. Uso: `pnpm whatsapp:echo <slug-del-negocio>`.
 *
 * Respeta la regla 6: el webhook solo guarda; esta herramienta lee lo guardado y contesta,
 * fuera del webhook. En H6 la reemplaza el worker. No corre en producción.
 */
const POLL_MS = 2_000;

const config = loadConfig(process.env);
const logger = createLogger(config);
const slug = process.argv[2];

if (config.nodeEnv === 'production' || !slug || !config.credentialsKey) {
  logger.error(
    'Uso: pnpm whatsapp:echo <slug-del-negocio>, con CREDENTIALS_ENCRYPTION_KEY en .env. ' +
      'Solo para desarrollo.',
  );
  process.exitCode = 1;
} else {
  const credentialsKey = config.credentialsKey;
  const database = createDatabase(config.databaseUrl);
  const { db } = database;
  const client = createWhatsAppClient({
    graphApiVersion: config.whatsapp?.graphApiVersion ?? 'v25.0',
  });

  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
  if (!tenant) {
    logger.error({ tenant: slug }, 'No existe un negocio con ese slug');
    process.exitCode = 1;
    await database.close();
  } else {
    const stop = new AbortController();
    process.once('SIGINT', () => {
      stop.abort();
    });

    // Solo contesta lo que llega desde ahora.
    let since = new Date();
    logger.info({ tenant: slug }, 'Eco escuchando. Mandá "hola", "botones" o "lista". Ctrl+C para salir.');

    while (!stop.signal.aborted) {
      const pending = await db
        .select({
          id: messages.id,
          customerId: conversations.customerId,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(
          conversations,
          and(eq(conversations.tenantId, messages.tenantId), eq(conversations.id, messages.conversationId)),
        )
        .where(
          and(
            eq(messages.tenantId, tenant.id),
            eq(messages.direction, 'inbound'),
            gt(messages.createdAt, since),
          ),
        )
        .orderBy(asc(messages.createdAt));

      for (const message of pending) {
        since = message.createdAt;
        const content = (message.content ?? {}) as Record<string, unknown>;
        try {
          const result = await sendWhatsAppMessage(
            { db, client, credentialsKey, now: new Date() },
            { tenantId: tenant.id, customerId: message.customerId, message: echoReply(content) },
          );
          logger.info({ result }, 'Eco enviado');
        } catch (error) {
          logger.error({ err: error }, 'No se pudo enviar el eco');
        }
      }
      await sleep(POLL_MS);
    }
    await database.close();
  }
}
