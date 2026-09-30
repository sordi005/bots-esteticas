// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Módulos de dominio: no conocen WhatsApp, Fastify ni la IA (CLAUDE.md, regla 3).
const domainModules = ['scheduling', 'catalog', 'customers', 'payments'];

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'migrations/'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: domainModules.map((name) => `src/modules/${name}/**/*.ts`),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fastify', 'fastify/**', '@fastify/**'],
              message: 'Regla 3: el dominio no conoce el servidor HTTP.',
            },
            {
              group: ['@anthropic-ai/**'],
              message: 'Regla 3: el dominio no conoce el SDK de IA.',
            },
            {
              group: [
                '**/whatsapp',
                '**/whatsapp/**',
                '**/conversation',
                '**/conversation/**',
                '**/notifications',
                '**/notifications/**',
              ],
              message: 'Regla 3: el dominio no conoce WhatsApp ni la IA.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Regla 5: la hora actual se inyecta (parámetro `now`), no se lee con new Date().',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Regla 5: la hora actual se inyecta (parámetro `now`), no se lee con Date.now().',
        },
      ],
    },
  },
);
