import { echoResponder } from './modules/conversation/echo-responder.js';
import { recordWebhookEvents } from './modules/conversation/inbox.js';
import { createWhatsAppClient } from './modules/whatsapp/client.js';
import { withRecipientOverride } from './modules/whatsapp/recipient-override.js';
import type { WhatsAppWebhookOptions } from './modules/whatsapp/webhook-routes.js';
import { buildServer } from './server.js';
import { loadConfig } from './shared/config.js';
import { createDatabase } from './shared/db.js';
import { createLogger } from './shared/logger.js';
import { buildWorker, type WorkerDependencies } from './worker.js';

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

// Worker de tareas programadas, en el mismo proceso (sección 6.7). Hasta que exista el
// agente (H7), las conversaciones se contestan solo en desarrollo, con el eco.
let conversations: WorkerDependencies['conversations'];
if (config.nodeEnv === 'production') {
  logger.warn('Las conversaciones no se procesan hasta que exista el agente (H7)');
} else if (!config.credentialsKey) {
  logger.warn('Sin CREDENTIALS_ENCRYPTION_KEY el worker no puede contestar conversaciones');
} else {
  const client = createWhatsAppClient({
    graphApiVersion: config.whatsapp?.graphApiVersion ?? 'v25.0',
  });
  conversations = {
    client: withRecipientOverride(client, config.whatsappTestRecipient ?? undefined),
    credentialsKey: config.credentialsKey,
    respond: echoResponder,
  };
  logger.info(
    { testRecipient: config.whatsappTestRecipient !== null },
    'El worker contesta las conversaciones con el eco de desarrollo',
  );
}
const worker = buildWorker({
  db: database.db,
  logger,
  ...(conversations ? { conversations } : {}),
});

const server = buildServer({
  logger,
  healthChecks: { database: database.ping, worker: worker.check },
  ...(whatsappWebhook ? { whatsappWebhook } : {}),
});
server.addHook('onClose', () => database.close());

// Apagado ordenado: primero el worker termina las tareas en curso, después el servidor
// termina los pedidos en curso, y al final se cierra la base.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Apagando el servidor');
    worker
      .stop()
      .then(() => server.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'Error al apagar el servidor');
          process.exit(1);
        },
      );
  });
}

worker.start();
await server.listen({ host: config.host, port: config.port });
