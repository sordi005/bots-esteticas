import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export interface Database {
  readonly db: NodePgDatabase;
  readonly pool: pg.Pool;
  /** Verifica que la base responda. Lo usa /health. */
  readonly ping: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export function createDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 });
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
