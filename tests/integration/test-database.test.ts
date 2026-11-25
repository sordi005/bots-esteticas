import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/shared/db.js';
import {
  configuredTestDatabaseUrl,
  ensureDatabaseExists,
  testDatabaseUrl,
  withDatabaseName,
  worktreeDatabaseUrl,
} from './support/database.js';

const database = createDatabase(testDatabaseUrl());

afterAll(async () => {
  await database.close();
});

async function databasesNamed(name: string): Promise<number> {
  const result = await database.db.execute<{ count: number }>(
    sql`select count(*)::int as count from pg_database where datname = ${name}`,
  );
  return result.rows[0]?.count ?? 0;
}

describe('base de los tests de integración', () => {
  it('es la de este worktree, no la configurada en TEST_DATABASE_URL', async () => {
    const result = await database.db.execute<{ name: string }>(sql`select current_database() as name`);
    const own = worktreeDatabaseUrl(configuredTestDatabaseUrl(), process.cwd());

    expect(result.rows[0]?.name).toBe(new URL(own).pathname.slice(1));
    expect(testDatabaseUrl()).not.toBe(configuredTestDatabaseUrl());
  });

  it('se crea si falta, y pedirla de nuevo no falla ni la duplica', async () => {
    const name = `bots_esteticas_nueva_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
    const url = withDatabaseName(testDatabaseUrl(), name);

    try {
      expect(await databasesNamed(name)).toBe(0);

      await ensureDatabaseExists(url, configuredTestDatabaseUrl());
      await ensureDatabaseExists(url, configuredTestDatabaseUrl());

      expect(await databasesNamed(name)).toBe(1);
    } finally {
      await database.db.execute(sql`drop database if exists ${sql.identifier(name)}`);
    }
  });
});
