import { describe, expect, it, onTestFinished } from 'vitest';
import { buildServer } from '../../src/server.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';

function serverAgainst(databaseUrl: string) {
  const database = createDatabase(databaseUrl);
  const server = buildServer({ healthChecks: { database: database.ping } });
  onTestFinished(async () => {
    await server.close();
    await database.close();
  });
  return server;
}

describe('GET /health contra Postgres real', () => {
  it('responde 200 cuando la base responde', async () => {
    const server = serverAgainst(testDatabaseUrl());

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('responde 503 cuando la base no está disponible', async () => {
    const missingDatabase = new URL(testDatabaseUrl());
    missingDatabase.pathname = '/base_que_no_existe';
    const server = serverAgainst(missingDatabase.toString());

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', checks: { database: 'error' } });
  });
});
