import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../../../src/shared/db.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** TEST_DATABASE_URL tal cual: dice el servidor y el nombre del que sale la base de cada worktree. */
export function configuredTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'Falta TEST_DATABASE_URL. Copiá .env.example a .env y levantá Postgres con `pnpm db:up`.',
    );
  }
  return url;
}

/**
 * La base de tests de un worktree: mismo servidor que `baseUrl`, con un hash de la raíz en el
 * nombre. Así dos `pnpm check` a la vez desde carpetas distintas no se borran las tablas.
 */
export function worktreeDatabaseUrl(baseUrl: string, worktreeRoot: string): string {
  assertIsTestDatabase(baseUrl);

  // En minúsculas: Windows no distingue "C:" de "c:" y tiene que dar la misma base.
  const root = resolve(worktreeRoot).toLowerCase();
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 8);
  const prefix = new URL(baseUrl).pathname.slice(1).replace(/_test$/, '');
  return withDatabaseName(baseUrl, `${prefix}_${hash}_test`);
}

/** La base contra la que corren los tests de este worktree. La crea el global setup. */
export function testDatabaseUrl(): string {
  return worktreeDatabaseUrl(configuredTestDatabaseUrl(), REPOSITORY_ROOT);
}

/** Crea la base de `url` si el servidor todavía no la tiene, conectado a `adminUrl`. */
export async function ensureDatabaseExists(url: string, adminUrl: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  const admin = createDatabase(adminUrl);
  try {
    const existing = await admin.db.execute(sql`select 1 from pg_database where datname = ${name}`);
    if (existing.rows.length === 0) {
      await admin.db.execute(sql`create database ${sql.identifier(name)}`);
    }
  } finally {
    await admin.close();
  }
}

/** Freno de seguridad: los tests borran la base, así que solo corren contra una "_test". */
export function assertIsTestDatabase(url: string): void {
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`Los tests solo corren contra una base terminada en "_test", no "${name}".`);
  }
}

/** Misma conexión que `url` pero apuntando a otra base del mismo servidor. */
export function withDatabaseName(url: string, databaseName: string): string {
  const other = new URL(url);
  other.pathname = `/${databaseName}`;
  return other.toString();
}
