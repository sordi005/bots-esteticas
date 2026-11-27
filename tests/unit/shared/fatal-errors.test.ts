import { describe, expect, it } from 'vitest';
import { handleFatalError } from '../../../src/shared/fatal-errors.js';
import { createLogger } from '../../../src/shared/logger.js';

function setup(flush: () => Promise<unknown> = () => Promise.resolve(true)) {
  const steps: string[] = [];
  const lines: string[] = [];
  const logger = createLogger({ logLevel: 'info' }, { write: (chunk: string) => void lines.push(chunk) });
  const deps = {
    logger,
    report: (error: unknown) => steps.push(`report ${(error as Error).message}`),
    flush: async () => {
      steps.push('flush');
      return flush();
    },
    exit: (code: number) => steps.push(`exit ${String(code)}`),
  };
  return { deps, steps, logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('handleFatalError: una excepción o promesa rechazada sin capturar (10.2)', () => {
  it('la reporta, la registra como fatal, espera el envío y termina con código 1', async () => {
    const { deps, steps, logs } = setup();

    await handleFatalError(deps, new Error('nadie la capturó'), 'uncaughtException');

    expect(steps).toEqual(['report nadie la capturó', 'flush', 'exit 1']);
    expect(logs()).toEqual([
      expect.objectContaining({ level: 60, origin: 'uncaughtException', err: expect.objectContaining({ message: 'nadie la capturó' }) as unknown }),
    ]);
  });

  it('si el envío falla, igual termina: quien supervisa el proceso lo reinicia', async () => {
    const { deps, steps } = setup(() => Promise.reject(new Error('sin red')));

    await handleFatalError(deps, new Error('rechazada'), 'unhandledRejection');

    expect(steps).toEqual(['report rechazada', 'flush', 'exit 1']);
  });
});
