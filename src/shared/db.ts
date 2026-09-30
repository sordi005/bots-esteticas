import { sql } from 'drizzle-orm';
import {
  drizzle,
  type NodePgDatabase,
  type NodePgQueryResultHKT,
} from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';

/** La base o una transacción abierta: lo que acepta una función que solo hace consultas. */
export type Queryable = PgDatabase<NodePgQueryResultHKT>;

export interface Database {
  readonly db: NodePgDatabase;
  readonly pool: pg.Pool;
  /** Verifica que la base responda. Lo usa /health. */
  readonly ping: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export function createDatabase(connectionString: string): Database {
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    // Toda la sesión en UTC: la base nunca depende de la zona del servidor (regla 5).
    options: '-c TimeZone=UTC',
  });
  const db = drizzle({ client: pool });

  return {
    db,
    pool,
    ping: async () => {
      await db.execute(sql`select 1`);
    },
    close: () => pool.end(),
  };
}
