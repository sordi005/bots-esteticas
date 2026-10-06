import { describe, expect, it, onTestFinished } from 'vitest';
import { buildServer } from '../../src/server.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { buildWorker } from '../../src/worker.js';
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

describe('GET /health con el worker (sección 10.2)', () => {
  it('suma el chequeo del worker: ok mientras corre, error cuando se apagó', async () => {
    const database = createDatabase(testDatabaseUrl());
    const worker = buildWorker({
      db: database.db,
      logger: createLogger({ logLevel: 'silent' }),
      options: { pollIntervalMs: 10 },
    });
    const server = buildServer({ healthChecks: { database: database.ping, worker: worker.check } });
    onTestFinished(async () => {
      await worker.stop();
      await server.close();
      await database.close();
    });

    worker.start();
    const running = await server.inject({ method: 'GET', url: '/health' });
    await worker.stop();
    const stopped = await server.inject({ method: 'GET', url: '/health' });

    expect(running.statusCode).toBe(200);
    expect(running.json()).toEqual({ status: 'ok', checks: { database: 'ok', worker: 'ok' } });
    expect(stopped.statusCode).toBe(503);
    expect(stopped.json()).toEqual({ status: 'error', checks: { database: 'ok', worker: 'error' } });
  });
});
