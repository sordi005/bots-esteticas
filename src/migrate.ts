import { loadConfig } from './shared/config.js';
import { createDatabase } from './shared/db.js';
import { createLogger } from './shared/logger.js';
import { runMigrations } from './shared/migrations.js';

// Punto de entrada: `pnpm db:migrate` en desarrollo, `node dist/migrate.js` en producción.
const config = loadConfig(process.env);
const logger = createLogger(config);
const database = createDatabase(config.databaseUrl);

try {
  await runMigrations(database.db);
  logger.info('Migraciones aplicadas');
} catch (error) {
  logger.fatal({ err: error }, 'Fallaron las migraciones');
  process.exitCode = 1;
} finally {
  await database.close();
}
