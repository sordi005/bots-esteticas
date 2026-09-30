export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'Falta TEST_DATABASE_URL. Copiá .env.example a .env y levantá Postgres con `pnpm db:up`.',
    );
  }
  return url;
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
