import { fileURLToPath } from 'node:url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/** `migrations/` en la raíz del repo, tanto desde `src/` (tsx) como desde `dist/` (compilado). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * Aplica las migraciones pendientes, en orden y dentro de una transacción.
 * Las ya aplicadas se saltean: correrlo dos veces no cambia nada.
 */
export async function runMigrations(db: NodePgDatabase): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
