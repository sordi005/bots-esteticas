import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/shared/db.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/shared/migrations.js';
import { testDatabaseUrl, withDatabaseName } from './support/database.js';

const MVP_TABLES = [
  'agent_runs',
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

describe('migración del medio de la seña (decisión 23)', () => {
  it('el enum ya no tiene "both" y el valor por defecto es transferencia', async () => {
    await withEmptyDatabase(async (database) => {
      await runMigrations(database.db);

      const values = await database.db.execute<{ value: string }>(sql`
        select e.enumlabel as value from pg_enum e
        join pg_type t on t.oid = e.enumtypid
        where t.typname = 'deposit_payment_options' order by e.enumsortorder
      `);
      const column = await database.db.execute<{ column_default: string }>(sql`
        select column_default from information_schema.columns
        where table_name = 'tenant_settings' and column_name = 'deposit_payment_options'
      `);

      expect(values.rows.map((row) => row.value)).toEqual(['mercadopago', 'transfer']);
      expect(column.rows[0]?.column_default).toMatch(/'transfer'/);
    });
  });

  it('un negocio que tenía "both" pasa a transferencia y los demás conservan su medio', async () => {
    await withEmptyDatabase(async (database) => {
      // Las migraciones hasta la última anterior al cambio: la base como estaba en producción.
      const before = mkdtempSync(join(tmpdir(), 'migraciones-'));
      try {
        cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
        const journalPath = join(before, 'meta', '_journal.json');
        const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
        const lastBefore = journal.entries.findIndex((entry) => entry.tag.startsWith('0009_'));
        journal.entries = journal.entries.slice(0, lastBefore);
        writeFileSync(journalPath, JSON.stringify(journal));

        await migrate(database.db, { migrationsFolder: before });
        await database.db.execute(sql`
          insert into tenants (id, name, slug, plan, assistant_name) values
            ('00000000-0000-4000-8000-0000000000a1', 'Con both', 'con-both', 'basic', 'Luna'),
            ('00000000-0000-4000-8000-0000000000a2', 'Con MP', 'con-mp', 'basic', 'Luna')
        `);
        await database.db.execute(sql`
          insert into tenant_settings (tenant_id, deposit_payment_options) values
            ('00000000-0000-4000-8000-0000000000a1', 'both'),
            ('00000000-0000-4000-8000-0000000000a2', 'mercadopago')
        `);
      } finally {
        rmSync(before, { recursive: true, force: true });
      }

      await runMigrations(database.db);

      const rows = await database.db.execute<{ slug: string; option: string }>(sql`
        select t.slug, s.deposit_payment_options::text as option
        from tenant_settings s join tenants t on t.id = s.tenant_id order by t.slug
      `);
      expect(rows.rows).toEqual([
        { slug: 'con-both', option: 'transfer' },
        { slug: 'con-mp', option: 'mercadopago' },
      ]);
    });
  });
});
