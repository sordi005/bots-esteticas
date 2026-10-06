import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY, nextRetryAt } from '../../../src/modules/jobs/retry-policy.js';

const NOW = new Date('2026-10-06T15:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('nextRetryAt: cuándo se reintenta una tarea que falló (sección 6.7)', () => {
  it('después del primer intento espera 30 segundos', () => {
    expect(nextRetryAt(1, NOW)).toEqual(later(30_000));
  });

  it('después del segundo intento espera 2 minutos', () => {
    expect(nextRetryAt(2, NOW)).toEqual(later(120_000));
  });

  it('después del tercer intento no se reintenta más', () => {
    expect(nextRetryAt(3, NOW)).toBeNull();
    expect(nextRetryAt(4, NOW)).toBeNull();
  });

  it('usa 3 intentos por defecto, los de la alerta de la sección 10.3', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
  });

  it('si hay más intentos que esperas, repite la última', () => {
    const policy = { maxAttempts: 5, retryDelaysMs: [1_000, 5_000] };

    expect(nextRetryAt(3, NOW, policy)).toEqual(later(5_000));
    expect(nextRetryAt(4, NOW, policy)).toEqual(later(5_000));
    expect(nextRetryAt(5, NOW, policy)).toBeNull();
  });
});
