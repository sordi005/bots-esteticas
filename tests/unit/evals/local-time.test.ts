import { describe, expect, it } from 'vitest';
import { EVAL_NOW, EVAL_TIME_ZONE } from '../../evals/clock.js';
import { formatLocalStart, parseLocalStart } from '../../evals/local-time.js';

describe('parseLocalStart', () => {
  it('lee "AAAA-MM-DD HH:MM" como hora local de Mendoza (UTC-3)', () => {
    expect(parseLocalStart('2026-10-13 17:00', EVAL_TIME_ZONE).toISOString()).toBe('2026-10-13T20:00:00.000Z');
    expect(parseLocalStart('2026-10-09 09:00', EVAL_TIME_ZONE).toISOString()).toBe('2026-10-09T12:00:00.000Z');
  });

  it('la hora fija de las evaluaciones es el jueves 8/10 a las 10:00', () => {
    expect(parseLocalStart('2026-10-08 10:00', EVAL_TIME_ZONE)).toEqual(EVAL_NOW);
  });

  it.each(['2026-10-13T17:00', '13/10 17:00', '2026-10-13', '2026-10-13 5pm', '2026-10-13 17:00:00', ''])(
    'rechaza "%s" con un mensaje que muestra el formato esperado',
    (text) => {
      expect(() => parseLocalStart(text, EVAL_TIME_ZONE)).toThrow(/AAAA-MM-DD HH:MM/);
    },
  );

  it('rechaza una fecha que no existe en el calendario', () => {
    expect(() => parseLocalStart('2026-02-30 10:00', EVAL_TIME_ZONE)).toThrow(/2026-02-30/);
  });
});

describe('formatLocalStart', () => {
  it('es la inversa de parseLocalStart', () => {
    for (const text of ['2026-10-13 17:00', '2026-10-09 09:00', '2026-10-14 15:30', '2026-12-31 23:45']) {
      expect(formatLocalStart(parseLocalStart(text, EVAL_TIME_ZONE), EVAL_TIME_ZONE)).toBe(text);
    }
  });

  it('pasa un instante UTC a la hora local del negocio, incluso si cambia el día', () => {
    expect(formatLocalStart(new Date('2026-10-14T02:30:00.000Z'), EVAL_TIME_ZONE)).toBe('2026-10-13 23:30');
  });
});
