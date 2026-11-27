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

describe('errores de las rutas (10.2)', () => {
  function serverReporting() {
    const reported: unknown[] = [];
    const server = buildServer({ healthChecks: {}, reportError: (error) => reported.push(error) });
    onTestFinished(() => server.close());
    return { server, reported };
  }

  it('un error inesperado responde 500 y se reporta (a Sentry, en main.ts)', async () => {
    const { server, reported } = serverReporting();
    const bug = new Error('se rompió algo');
    server.get('/falla', () => Promise.reject(bug));

    const response = await server.inject({ method: 'GET', url: '/falla' });

    expect(response.statusCode).toBe(500);
    expect(reported).toEqual([bug]);
  });

  it('un error del pedido (4xx) responde con su código y no se reporta: no es un bug', async () => {
    const { server, reported } = serverReporting();
    server.post('/datos', () => 'ok');

    const response = await server.inject({
      method: 'POST',
      url: '/datos',
      headers: { 'content-type': 'application/json' },
      payload: '{roto',
    });

    expect(response.statusCode).toBe(400);
    expect(reported).toEqual([]);
  });
});
