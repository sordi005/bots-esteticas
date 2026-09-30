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

const server = buildServer({ logger, healthChecks: { database: database.ping } });
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
