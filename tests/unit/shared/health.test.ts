import { describe, expect, it } from 'vitest';
import { runHealthChecks } from '../../../src/shared/health.js';

const passes = () => Promise.resolve();
const neverAnswers = () => new Promise<void>(() => undefined);

describe('runHealthChecks', () => {
  it('informa ok cuando todos los chequeos pasan', async () => {
    const report = await runHealthChecks({ database: passes, other: passes }, { timeoutMs: 100 });

    expect(report).toEqual({ status: 'ok', checks: { database: 'ok', other: 'ok' } });
  });

  it('informa error si un chequeo falla, sin dejar de reportar los demás', async () => {
    const report = await runHealthChecks(
      { database: () => Promise.reject(new Error('caída')), other: passes },
      { timeoutMs: 100 },
    );

    expect(report).toEqual({ status: 'error', checks: { database: 'error', other: 'ok' } });
  });

  it('trata como error un chequeo que no responde a tiempo', async () => {
    const report = await runHealthChecks({ database: neverAnswers }, { timeoutMs: 10 });

    expect(report).toEqual({ status: 'error', checks: { database: 'error' } });
  });

  it('trata como error un chequeo que lanza de forma sincrónica', async () => {
    const throwsImmediately = (): Promise<void> => {
      throw new Error('explotó');
    };

    const report = await runHealthChecks({ database: throwsImmediately }, { timeoutMs: 100 });

    expect(report).toEqual({ status: 'error', checks: { database: 'error' } });
  });

  it('avisa cada falla con el nombre del chequeo y su causa', async () => {
    const cause = new Error('caída');
    const failures: { name: string; error: unknown }[] = [];

    await runHealthChecks(
      { database: () => Promise.reject(cause), other: passes },
      {
        timeoutMs: 100,
        onFailure: (name, error) => failures.push({ name, error }),
      },
    );

    expect(failures).toEqual([{ name: 'database', error: cause }]);
  });

  it('indica el tiempo límite en la causa de un chequeo que no respondió', async () => {
    const failures: unknown[] = [];

    await runHealthChecks(
      { database: neverAnswers },
      { timeoutMs: 10, onFailure: (_name, error) => failures.push(error) },
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(Error);
    expect((failures[0] as Error).message).toContain('10 ms');
  });
});
