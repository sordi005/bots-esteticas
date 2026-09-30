import { describe, expect, it } from 'vitest';
import { formatTimestampRange, parseTimestampRange } from '../../../src/shared/timestamp-range.js';

const start = new Date('2026-10-03T18:30:00.000Z');
const end = new Date('2026-10-03T19:40:00.000Z');

describe('formatTimestampRange', () => {
  it('escribe el rango semiabierto [inicio, fin) en ISO UTC', () => {
    expect(formatTimestampRange({ start, end })).toBe(
      '[2026-10-03T18:30:00.000Z,2026-10-03T19:40:00.000Z)',
    );
  });

  it.each([
    ['el fin es igual al inicio', start, start],
    ['el fin es anterior al inicio', end, start],
  ])('falla si %s', (_case, rangeStart, rangeEnd) => {
    expect(() => formatTimestampRange({ start: rangeStart, end: rangeEnd })).toThrow(/rango/i);
  });

  it('falla con una fecha inválida', () => {
    expect(() => formatTimestampRange({ start: new Date('no es fecha'), end })).toThrow(/fecha/i);
  });
});

describe('parseTimestampRange', () => {
  it('lee el formato que devuelve Postgres en una sesión UTC', () => {
    expect(parseTimestampRange('["2026-10-03 18:30:00+00","2026-10-03 19:40:00+00")')).toEqual({
      start,
      end,
    });
  });

  it('lee fracciones de segundo y otros husos horarios', () => {
    expect(
      parseTimestampRange('["2026-10-03 15:30:00.25-03","2026-10-04 01:10:00+05:30")'),
    ).toEqual({
      start: new Date('2026-10-03T18:30:00.250Z'),
      end: new Date('2026-10-03T19:40:00.000Z'),
    });
  });

  it('vuelve a leer lo que escribe formatTimestampRange', () => {
    expect(parseTimestampRange(formatTimestampRange({ start, end }))).toEqual({ start, end });
  });

  it.each([
    ['un rango vacío', 'empty'],
    ['un inicio abierto', '("2026-10-03 18:30:00+00","2026-10-03 19:40:00+00")'],
    ['un fin cerrado', '["2026-10-03 18:30:00+00","2026-10-03 19:40:00+00"]'],
    ['un inicio infinito', '[,"2026-10-03 19:40:00+00")'],
    ['un fin infinito', '["2026-10-03 18:30:00+00",)'],
    ['una fecha ilegible', '["mañana","2026-10-03 19:40:00+00")'],
  ])('rechaza %s', (_case, value) => {
    expect(() => parseTimestampRange(value)).toThrow();
  });
});
