import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { agentOutcomes } from '../../src/modules/conversation/agent/outcome.js';
import { agentRuns } from '../../src/modules/conversation/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single } from './support/fixtures.js';
import { CHECK_VIOLATION, expectConstraintViolation } from './support/postgres-errors.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

describe('agent_runs: una fila por respuesta del agente (7.2, 8.5)', () => {
  it('guarda el modelo, los tokens, los nombres de las herramientas y la latencia', async () => {
    const tenant = await createTenantFixture(db);

    const row = single(
      await db
        .insert(agentRuns)
        .values({
          tenantId: tenant.tenantId,
          conversationId: tenant.conversationId,
          model: 'claude-haiku-5-5',
          llmCalls: 2,
          inputTokens: 1_200,
          outputTokens: 80,
          cacheReadTokens: 800,
          cacheWriteTokens: 400,
          toolCalls: ['buscar_servicios', 'consultar_disponibilidad'],
          latencyMs: 1_850,
          outcome: 'replied',
        })
        .returning(),
    );

    expect(row).toMatchObject({
      model: 'claude-haiku-5-5',
      llmCalls: 2,
      inputTokens: 1_200,
      outputTokens: 80,
      cacheReadTokens: 800,
      cacheWriteTokens: 400,
      toolCalls: ['buscar_servicios', 'consultar_disponibilidad'],
      latencyMs: 1_850,
      outcome: 'replied',
    });
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('una respuesta sin llamar al modelo (límite por hora) no tiene modelo ni herramientas', async () => {
    const tenant = await createTenantFixture(db);

    const row = single(
      await db
        .insert(agentRuns)
        .values({
          tenantId: tenant.tenantId,
          conversationId: tenant.conversationId,
          model: null,
          llmCalls: 0,
          outcome: 'rate_limited',
        })
        .returning(),
    );

    expect(row).toMatchObject({ model: null, llmCalls: 0, inputTokens: 0, toolCalls: [], latencyMs: 0 });
    expect(await db.select().from(agentRuns).where(eq(agentRuns.id, row.id))).toHaveLength(1);
  });

  it('el motivo de fin es de una lista cerrada: la de agent/outcome.ts', async () => {
    const result = await db.execute<{ values: string[] }>(
      sql`select enum_range(null::agent_outcome)::text[] as values`,
    );

    expect(result.rows[0]?.values).toEqual([...agentOutcomes]);
  });

  it('los tokens, las llamadas y la latencia no pueden ser negativos', async () => {
    const tenant = await createTenantFixture(db);
    const base = {
      tenantId: tenant.tenantId,
      conversationId: tenant.conversationId,
      model: 'claude-haiku-5-5',
      llmCalls: 1,
      outcome: 'replied',
    } as const;

    await expectConstraintViolation(
      db.insert(agentRuns).values({ ...base, outputTokens: -1 }),
      CHECK_VIOLATION,
      'agent_runs_usage_non_negative',
    );
    await expectConstraintViolation(
      db.insert(agentRuns).values({ ...base, latencyMs: -5 }),
      CHECK_VIOLATION,
      'agent_runs_calls_and_latency_non_negative',
    );
  });

  it('hay modelo si y solo si hubo llamadas al modelo', async () => {
    const tenant = await createTenantFixture(db);
    const base = { tenantId: tenant.tenantId, conversationId: tenant.conversationId, outcome: 'replied' } as const;

    await expectConstraintViolation(
      db.insert(agentRuns).values({ ...base, model: null, llmCalls: 1 }),
      CHECK_VIOLATION,
      'agent_runs_model_matches_calls',
    );
    await expectConstraintViolation(
      db.insert(agentRuns).values({ ...base, model: 'claude-haiku-5-5', llmCalls: 0 }),
      CHECK_VIOLATION,
      'agent_runs_model_matches_calls',
    );
  });
});
