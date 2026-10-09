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
          // Contratos con servicios externos: sus ejemplos reales, sin red ni base (11.3).
          name: 'contracts',
          include: ['tests/contracts/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // Deja la base de tests vacía y migrada antes de empezar.
          globalSetup: ['tests/integration/support/global-setup.ts'],
          // Comparten la misma base real: un archivo por vez.
          fileParallelism: false,
        },
      },
      {
        test: {
          // Evaluaciones del asistente (11.4): llaman a la API real y cuestan plata. Solo con
          // `pnpm test:evals`; ni `pnpm test` ni CI las corren.
          name: 'evals',
          include: ['tests/evals/**/*.eval.ts'],
          // Misma base de tests, vacía y migrada.
          globalSetup: ['tests/integration/support/global-setup.ts'],
          fileParallelism: false,
          // Cada caso llama al modelo, a veces varias veces.
          testTimeout: 60_000,
        },
      },
    ],
  },
});
