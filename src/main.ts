import { recordWebhookEvents } from './modules/conversation/inbox.js';
import type { WhatsAppWebhookOptions } from './modules/whatsapp/webhook-routes.js';
import { buildServer } from './server.js';
import { loadConfig } from './shared/config.js';
import { createDatabase } from './shared/db.js';
import { createLogger } from './shared/logger.js';

const config = loadConfig(process.env);
const logger = createLogger(config);
const database = createDatabase(config.databaseUrl);

// Sin este handler, un error en una conexión inactiva del pool tira abajo el proceso.
database.pool.on('error', (error) => {
  logger.error({ err: error }, 'Error en una conexión inactiva de Postgres');
});

// Webhook de WhatsApp: guarda lo que llega y responde 200 (regla 6). Sin la app de Meta
// configurada no se registra, y el resto del servidor funciona igual.
const whatsappWebhook: WhatsAppWebhookOptions | undefined = config.whatsapp
  ? {
      appSecret: config.whatsapp.appSecret,
      verifyToken: config.whatsapp.verifyToken,
      onEvents: async (events, log) => {
        const { failedDeliveries, ...counts } = await recordWebhookEvents(database.db, events, {
          now: new Date(),
        });
        log[counts.unknownNumber > 0 ? 'warn' : 'info'](counts, 'Webhook de WhatsApp guardado');
        for (const failure of failedDeliveries) {
          log.warn(failure, 'Meta no pudo entregar un mensaje');
        }
      },
    }
  : undefined;
if (!whatsappWebhook) {
  logger.warn('WhatsApp no está configurado: el webhook no se registra');
}

const server = buildServer({
  logger,
  healthChecks: { database: database.ping },
  ...(whatsappWebhook ? { whatsappWebhook } : {}),
});
server.addHook('onClose', () => database.close());

// Apagado ordenado: termina los pedidos en curso y cierra la base antes de salir.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Apagando el servidor');
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'Error al apagar el servidor');
        process.exit(1);
      },
    );
  });
}

await server.listen({ host: config.host, port: config.port });
