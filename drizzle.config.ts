import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit no lee .env solo.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Falta DATABASE_URL. Copiá .env.example a .env.');
}

export default defineConfig({
  dialect: 'postgresql',
  // Cada módulo declara sus tablas en su propio schema.ts (desde H2).
  schema: './src/modules/*/schema.ts',
  out: './migrations',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
