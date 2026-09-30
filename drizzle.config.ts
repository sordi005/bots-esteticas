import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit no lee .env solo.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Generar migraciones no necesita conexión; `drizzle-kit studio` sí.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  dialect: 'postgresql',
  // Cada módulo declara sus tablas en su propio schema.ts.
  schema: './src/modules/*/schema.ts',
  out: './migrations',
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {}),
  strict: true,
  verbose: true,
});
