import { DEMO_TENANT_SLUG, seedEsteticaEjemplo } from './seeds/estetica-ejemplo.js';
import { loadConfig } from './shared/config.js';
import { createDatabase } from './shared/db.js';
import { createLogger } from './shared/logger.js';

// Punto de entrada: `pnpm db:seed` en desarrollo, `node dist/seed.js` para la demo.
const config = loadConfig(process.env);
const logger = createLogger(config);
const database = createDatabase(config.databaseUrl);

try {
  await seedEsteticaEjemplo(database.db);
  logger.info({ tenant: DEMO_TENANT_SLUG }, 'Datos de ejemplo cargados');
} catch (error) {
  logger.fatal({ err: error }, 'Falló la carga de datos de ejemplo');
  process.exitCode = 1;
} finally {
  await database.close();
}
