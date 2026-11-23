import { describe, expect, it } from 'vitest';
import {
  EXCLUSION_VIOLATION,
  findPostgresError,
  isConstraintViolation,
  DEADLOCK_DETECTED,
  MAX_DEADLOCK_ATTEMPTS,
  retryOnDeadlock,
} from '../../../src/shared/postgres-errors.js';

function driverError(code: string, constraint?: string): Error {
  return Object.assign(new Error('error del driver'), { code, constraint });
}

describe('findPostgresError', () => {
  it('encuentra el error de Postgres dentro de la cadena de causas que arma Drizzle', () => {
    const wrapped = new Error('Failed query', {
      cause: new Error('otra capa', { cause: driverError('23P01', 'appointments_no_overlap') }),
    });

    expect(findPostgresError(wrapped)).toEqual({ code: '23P01', constraint: 'appointments_no_overlap' });
  });

  it('no inventa nada si no hay un error de Postgres', () => {
    expect(findPostgresError(new Error('otra cosa'))).toBeUndefined();
    expect(findPostgresError('no es un error')).toBeUndefined();
  });
});

describe('isConstraintViolation', () => {
  const overlap = new Error('Failed query', {
    cause: driverError(EXCLUSION_VIOLATION, 'appointments_no_overlap'),
  });

  it('reconoce la restricción puntual que falló', () => {
    expect(isConstraintViolation(overlap, EXCLUSION_VIOLATION, 'appointments_no_overlap')).toBe(true);
  });

  it('no confunde otra restricción ni otro tipo de error', () => {
    expect(isConstraintViolation(overlap, EXCLUSION_VIOLATION, 'otra_restriccion')).toBe(false);
    expect(isConstraintViolation(overlap, '23505', 'appointments_no_overlap')).toBe(false);
  });
});

describe('retryOnDeadlock: varias reservas del mismo horario a la vez (6.6)', () => {
  // Con una restricción de exclusión, dos inserciones simultáneas que chocan pueden esperarse una a
  // la otra: Postgres aborta una con "deadlock detected" en vez de la violación de la restricción.
  const deadlock = () => new Error('Failed query', { cause: driverError(DEADLOCK_DETECTED) });
  const noWait = () => Promise.resolve();

  /** Una transacción que pierde por deadlock las primeras `failures` veces y después resuelve. */
  function failingTimes(failures: number) {
    const state = { calls: 0 };
    const run = () => {
      state.calls += 1;
      return state.calls <= failures ? Promise.reject(deadlock()) : Promise.resolve('ok');
    };
    return { state, run };
  }

  it('reintenta la transacción que perdió por deadlock', async () => {
    const { state, run } = failingTimes(1);

    await expect(retryOnDeadlock(run, { wait: noWait })).resolves.toBe('ok');
    expect(state.calls).toBe(2);
  });

  it('con cinco a la vez, las que pierden pueden volver a trabarse entre sí: sigue reintentando', async () => {
    const { state, run } = failingTimes(2);

    await expect(retryOnDeadlock(run, { wait: noWait })).resolves.toBe('ok');
    expect(state.calls).toBe(3);
  });

  it('espera un rato al azar antes de cada reintento, para que no vuelvan a chocar juntas', async () => {
    const { run } = failingTimes(2);
    const waits: number[] = [];

    await retryOnDeadlock(run, {
      wait: (attempt) => {
        waits.push(attempt);
        return Promise.resolve();
      },
    });

    expect(waits).toEqual([1, 2]);
  });

  it(`el reintento tiene tope: después de ${String(MAX_DEADLOCK_ATTEMPTS)} intentos el error sube`, async () => {
    const { state, run } = failingTimes(Number.POSITIVE_INFINITY);

    await expect(retryOnDeadlock(run, { wait: noWait })).rejects.toThrow('Failed query');
    expect(state.calls).toBe(MAX_DEADLOCK_ATTEMPTS);
  });

  it('cualquier otro error sube sin reintentar', async () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      return Promise.reject(new Error('Failed query', { cause: driverError(EXCLUSION_VIOLATION, 'appointments_no_overlap') }));
    };

    await expect(retryOnDeadlock(run, { wait: noWait })).rejects.toThrow('Failed query');
    expect(calls).toBe(1);
  });

  it('sin espera inyectada, espera de verdad y resuelve', async () => {
    const { state, run } = failingTimes(1);

    await expect(retryOnDeadlock(run)).resolves.toBe('ok');
    expect(state.calls).toBe(2);
  });
});
