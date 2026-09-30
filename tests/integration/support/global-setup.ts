import { sql } from 'drizzle-orm';
import { createDatabase } from '../../../src/shared/db.js';
import { runMigrations } from '../../../src/shared/migrations.js';
import { assertIsTestDatabase, testDatabaseUrl } from './database.js';

/** Antes de correr los tests de integración: base de tests vacía y con todas las migraciones. */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  assertIsTestDatabase(url);

  const database = createDatabase(url);
  try {
    await database.db.execute(sql`drop schema if exists drizzle cascade`);
    await database.db.execute(sql`drop schema if exists public cascade`);
    await database.db.execute(sql`create schema public`);
    await runMigrations(database.db);
  } finally {
    await database.close();
  }
}
