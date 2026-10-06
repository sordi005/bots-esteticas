import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/shared/db.js';
import { runMigrations } from '../../src/shared/migrations.js';
import { testDatabaseUrl, withDatabaseName } from './support/database.js';

const MVP_TABLES = [
  'appointment_events',
  'appointments',
  'audit_log',
  'business_info',
  'conversations',
  'customers',
  'deposits',
  'handoffs',
  'holidays',
  'message_templates',
  'messages',
  'professional_services',
  'professionals',
  'schedule_exceptions',
  'scheduled_jobs',
  'services',
  'tenant_credentials',
  'tenant_settings',
  'tenants',
  'working_hours',
];

async function publicTables(database: Database): Promise<string[]> {
  const result = await database.db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `);
  return result.rows.map((row) => row.table_name);
}

async function appliedMigrations(database: Database): Promise<number> {
  const result = await database.db.execute<{ count: number }>(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  );
  return result.rows[0]?.count ?? 0;
}

/** Crea una base vacía, corre `test` contra ella y la borra al final pase lo que pase. */
async function withEmptyDatabase(test: (database: Database) => Promise<void>): Promise<void> {
  const name = `bots_esteticas_migracion_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = createDatabase(testDatabaseUrl());
  await admin.db.execute(sql.raw(`create database ${name}`));

  const fresh = createDatabase(withDatabaseName(testDatabaseUrl(), name));
  try {
    await test(fresh);
  } finally {
    await fresh.close();
    await admin.db.execute(sql.raw(`drop database if exists ${name}`));
    await admin.close();
  }
}

describe('migraciones', () => {
  it('crean todas las tablas del modelo en una base vacía', async () => {
    await withEmptyDatabase(async (database) => {
      await runMigrations(database.db);

      expect(await publicTables(database)).toEqual(MVP_TABLES);
    });
  });

  it('se pueden correr dos veces sin cambiar nada', async () => {
    await withEmptyDatabase(async (database) => {
      await runMigrations(database.db);
      const migrationsAfterFirstRun = await appliedMigrations(database);

      await runMigrations(database.db);

      expect(migrationsAfterFirstRun).toBeGreaterThan(0);
      expect(await appliedMigrations(database)).toBe(migrationsAfterFirstRun);
      expect(await publicTables(database)).toEqual(MVP_TABLES);
    });
  });
});
