import { describe, expect, it, onTestFinished } from 'vitest';
import { buildServer } from '../../src/server.js';
import type { HealthCheck } from '../../src/shared/health.js';

function serverWith(healthChecks: Record<string, HealthCheck>) {
  const server = buildServer({ healthChecks, healthCheckTimeoutMs: 50 });
  onTestFinished(() => server.close());
  return server;
}

describe('GET /health', () => {
  it('responde 200 con el detalle de cada chequeo cuando todo está bien', async () => {
    const server = serverWith({ database: () => Promise.resolve() });

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('responde 503 cuando falla un chequeo, para que el monitor externo lo detecte', async () => {
    const server = serverWith({ database: () => Promise.reject(new Error('caída')) });

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', checks: { database: 'error' } });
  });

  it('no expone el detalle interno del error en la respuesta', async () => {
    const server = serverWith({
      database: () => Promise.reject(new Error('password authentication failed for user "postgres"')),
    });

    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.body).not.toContain('password');
  });
});
