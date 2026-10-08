import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicLlmClient } from '../../src/modules/conversation/agent/anthropic-client.js';
import { DEMO_TENANT_ID, seedEsteticaEjemplo } from '../../src/seeds/estetica-ejemplo.js';
import { loadConfig } from '../../src/shared/config.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from '../integration/support/database.js';
import { evalCases } from './cases.js';
import { evaluateCase } from './evaluate.js';
import { formatReport, type CaseReport } from './report.js';
import { runEvalCase } from './run-case.js';

/**
 * Las evaluaciones del asistente (sección 11.4) contra la API REAL de Claude y la base de tests,
 * con los datos de "Estética Ejemplo" y la hora fija de `clock.ts`. Cuestan plata: no corren en
 * CI ni en `pnpm check`, solo con `pnpm test:evals`, antes de desplegar cambios del agente o de
 * los prompts. Al final imprime una tabla con los aciertos, los tokens y el costo estimado.
 */

// DATABASE_URL no se usa acá (las evaluaciones van a la base de tests), pero loadConfig la pide.
const config = loadConfig({ DATABASE_URL: testDatabaseUrl(), ...process.env });
const apiKey = config.anthropicApiKey;
if (!apiKey) {
  throw new Error('Las evaluaciones llaman a la API real: cargá ANTHROPIC_API_KEY en .env');
}

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const llm = createAnthropicLlmClient({ apiKey, model: config.anthropicModel });

const reports: CaseReport[] = [];

beforeAll(() => seedEsteticaEjemplo(db));

afterAll(async () => {
  await database.close();
  // Solo el resumen: nunca la configuración (tiene la clave).
  console.log(`\n${formatReport(reports, config.anthropicModel)}\n`);
});

describe('evaluaciones del asistente', () => {
  it.each(evalCases)('$nombre', async (evalCase) => {
    let report: CaseReport;
    try {
      const resultado = await runEvalCase({ db, llm, tenantId: DEMO_TENANT_ID }, evalCase);
      report = { nombre: evalCase.nombre, resultado, motivos: evaluateCase(evalCase, resultado).motivos };
    } catch (error) {
      // Un error de la API o de la base también es un fallo del caso: va al resumen y al test.
      const message = error instanceof Error ? error.message : String(error);
      reports.push({ nombre: evalCase.nombre, resultado: null, motivos: [`Error: ${message}`] });
      throw error;
    }
    reports.push(report);
    expect(report.motivos).toEqual([]);
  });
});
