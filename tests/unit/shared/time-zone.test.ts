import { describe, expect, it } from 'vitest';
import {
  addDaysToLocalDate,
  instantToLocal,
  isoWeekday,
  localDateTimeToInstant,
  parseLocalTime,
} from '../../../src/shared/time-zone.js';

const MENDOZA = 'America/Argentina/Mendoza';
const MADRID = 'Europe/Madrid';

describe('localDateTimeToInstant', () => {
  it('convierte la hora de Mendoza (UTC-3) a un instante UTC', () => {
    expect(localDateTimeToInstant('2026-10-05', '09:00', MENDOZA)).toEqual(
      new Date('2026-10-05T12:00:00.000Z'),
    );
  });

  it('acepta segundos, como los devuelve Postgres en una columna time', () => {
    expect(localDateTimeToInstant('2026-10-05', '20:30:00', MENDOZA)).toEqual(
      new Date('2026-10-05T23:30:00.000Z'),
    );
  });

  it('usa el offset que corresponde a cada fecha en una zona con horario de verano', () => {
    expect(localDateTimeToInstant('2026-03-28', '10:00', MADRID)).toEqual(
      new Date('2026-03-28T09:00:00.000Z'),
    );
    expect(localDateTimeToInstant('2026-03-29', '10:00', MADRID)).toEqual(
      new Date('2026-03-29T08:00:00.000Z'),
    );
  });

  it('corre hacia adelante una hora que no existe (el reloj salta de 2:00 a 3:00)', () => {
    expect(localDateTimeToInstant('2026-03-29', '02:30', MADRID)).toEqual(
      new Date('2026-03-29T01:30:00.000Z'),
    );
  });

  it('elige la primera vez de una hora que ocurre dos veces (el reloj vuelve de 3:00 a 2:00)', () => {
    expect(localDateTimeToInstant('2026-10-25', '02:30', MADRID)).toEqual(
      new Date('2026-10-25T00:30:00.000Z'),
    );
  });
});

describe('instantToLocal', () => {
  it('devuelve fecha, hora y día de la semana en la zona del negocio', () => {
    expect(instantToLocal(new Date('2026-10-05T12:15:00.000Z'), MENDOZA)).toEqual({
      date: '2026-10-05',
      time: '09:15',
      minutesOfDay: 555,
      weekday: 1,
    });
  });

  it('cambia de día cuando en UTC ya es mañana pero en Mendoza todavía es hoy', () => {
    expect(instantToLocal(new Date('2026-10-05T02:30:00.000Z'), MENDOZA)).toEqual({
      date: '2026-10-04',
      time: '23:30',
      minutesOfDay: 1410,
      weekday: 7,
    });
  });

  it('respeta el horario de verano', () => {
    expect(instantToLocal(new Date('2026-07-01T10:00:00.000Z'), MADRID).time).toBe('12:00');
    expect(instantToLocal(new Date('2026-12-01T10:00:00.000Z'), MADRID).time).toBe('11:00');
  });
});

describe('fechas locales', () => {
  it.each([
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-10-05', 0, '2026-10-05'],
  ])('%s más %i días es %s', (date, days, expected) => {
    expect(addDaysToLocalDate(date, days)).toBe(expected);
  });

  it.each([
    ['2026-10-05', 1],
    ['2026-10-10', 6],
    ['2026-10-04', 7],
  ])('el día ISO de %s es %i (1 = lunes, 7 = domingo)', (date, weekday) => {
    expect(isoWeekday(date)).toBe(weekday);
  });

  it.each([
    ['09:00', 540],
    ['20:30:00', 1230],
    ['00:00', 0],
    ['23:59', 1439],
  ])('%s son %i minutos desde la medianoche', (time, minutes) => {
    expect(parseLocalTime(time)).toBe(minutes);
  });

  it.each(['24:00', '9:00', '09:60', 'nueve'])('rechaza la hora inválida %j', (time) => {
    expect(() => parseLocalTime(time)).toThrow(/hora/i);
  });

  it('rechaza una fecha inválida', () => {
    expect(() => addDaysToLocalDate('2026-13-01', 1)).toThrow(/fecha/i);
  });
});
