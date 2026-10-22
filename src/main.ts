import { createAgentResponder } from './modules/conversation/agent/agent-responder.js';
import { createAnthropicLlmClient } from './modules/conversation/agent/anthropic-client.js';
import { recordWebhookEvents } from './modules/conversation/inbox.js';
import { createWhatsAppClient } from './modules/whatsapp/client.js';
import { withRecipientOverride } from './modules/whatsapp/recipient-override.js';
import type { WhatsAppWebhookOptions } from './modules/whatsapp/webhook-routes.js';
import { chooseConversationMode } from './conversation-mode.js';
import { buildServer } from './server.js';
import { DEFAULT_GRAPH_API_VERSION, loadConfig } from './shared/config.js';
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
          ...(config.notificationsNumber ? { notificationsPhoneNumberId: config.notificationsNumber.phoneNumberId } : {}),
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

// Un solo cliente de WhatsApp para contestar y para los avisos. En desarrollo, con el número de
// prueba de Meta, todo envío va al número de la lista de permitidos (8.1).
const whatsappClient = withRecipientOverride(
  createWhatsAppClient({ graphApiVersion: config.whatsapp?.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION }),
  config.whatsappTestRecipient ?? undefined,
);

// Worker de tareas programadas, en el mismo proceso (sección 6.7). Las conversaciones las contesta
// el agente (8.5), también en producción desde H8; en desarrollo, solo con las claves puestas.
let conversations: WorkerDependencies['conversations'];
const conversationMode = chooseConversationMode(config);
switch (conversationMode.kind) {
  case 'disabled':
    switch (conversationMode.reason) {
      case 'missing_credentials_key':
        logger.warn('Sin CREDENTIALS_ENCRYPTION_KEY el worker no puede contestar conversaciones');
        break;
      case 'missing_anthropic_key':
        logger.warn('Sin ANTHROPIC_API_KEY el worker no contesta conversaciones');
        break;
    }
    break;
  case 'agent': {
    conversations = {
      client: whatsappClient,
      credentialsKey: conversationMode.credentialsKey,
      respond: createAgentResponder({
        db: database.db,
        llm: createAnthropicLlmClient({
          apiKey: conversationMode.anthropicApiKey,
          model: config.anthropicModel,
        }),
        logger,
        now: () => new Date(),
      }),
    };
    logger.info(
      { model: config.anthropicModel, testRecipient: config.whatsappTestRecipient !== null },
      'El worker contesta las conversaciones con el agente',
    );
    break;
  }
}

// Avisos a la dueña y a la clienta (6.7, 8.2): sin la clave de cifrado no hay cómo leer el token del negocio.
const notifications: WorkerDependencies['notifications'] = config.credentialsKey
  ? {
      client: whatsappClient,
      credentialsKey: config.credentialsKey,
      preferTemplates: config.preferTemplates,
      ...(config.notificationsNumber ? { notificationsNumber: config.notificationsNumber } : {}),
    }
  : undefined;
if (notifications && config.preferTemplates) {
  logger.warn('WHATSAPP_PREFER_TEMPLATES: los avisos salen directo con su plantilla (solo desarrollo)');
}
if (notifications) {
  logger.info(
    { notificationsNumber: config.notificationsNumber !== null },
    config.notificationsNumber
      ? 'Los avisos a las dueñas salen del número de avisos'
      : 'Los avisos a las dueñas salen del número de cada negocio (fase 0)',
  );
} else {
  logger.warn('Sin CREDENTIALS_ENCRYPTION_KEY los avisos no se envían');
}

const worker = buildWorker({
  db: database.db,
  logger,
  ...(conversations ? { conversations } : {}),
  ...(notifications ? { notifications } : {}),
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
