import { describe, expect, it } from 'vitest';
import {
  EXCLUSION_VIOLATION,
  findPostgresError,
  isConstraintViolation,
  DEADLOCK_DETECTED,
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

describe('retryOnDeadlock: dos reservas del mismo horario a la vez (6.6)', () => {
  // Con una restricción de exclusión, dos inserciones simultáneas que chocan pueden esperarse una a
  // la otra: Postgres aborta una con "deadlock detected" en vez de la violación de la restricción.
  const deadlock = () => new Error('Failed query', { cause: driverError(DEADLOCK_DETECTED) });

  it('reintenta una vez la transacción que perdió por deadlock', async () => {
    let calls = 0;
    const result = await retryOnDeadlock(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(deadlock()) : Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('si vuelve a perder por deadlock, el error sube', async () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      return Promise.reject(deadlock());
    };

    await expect(retryOnDeadlock(run)).rejects.toThrow('Failed query');
    expect(calls).toBe(2);
  });

  it('cualquier otro error sube sin reintentar', async () => {
    let calls = 0;
    const run = () => {
      calls += 1;
      return Promise.reject(new Error('Failed query', { cause: driverError(EXCLUSION_VIOLATION, 'appointments_no_overlap') }));
    };

    await expect(retryOnDeadlock(run)).rejects.toThrow('Failed query');
    expect(calls).toBe(1);
  });
});
