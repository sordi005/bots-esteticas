import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Vitest no carga .env en process.env (los tests de integración lo necesitan).
// En CI no hay .env: las variables vienen del workflow.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // Comparten la misma base real: un archivo por vez.
          fileParallelism: false,
        },
      },
    ],
  },
});
