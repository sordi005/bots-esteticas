export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'Falta TEST_DATABASE_URL. Copiá .env.example a .env y levantá Postgres con `pnpm db:up`.',
    );
  }
  return url;
}
