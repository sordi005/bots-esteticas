import { describe, expect, it } from 'vitest';
import {
  describeHumanAttention,
  nextHumanAttention,
  type HumanAttention,
} from '../../../src/modules/conversation/attention-hours.js';
import type { AttentionHoursBlock } from '../../../src/modules/tenants/schema.js';

const MENDOZA = 'America/Argentina/Mendoza';

/** Lunes a viernes de 9 a 18. */
const WEEKDAYS: AttentionHoursBlock[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' }));

/** Hora de Mendoza (UTC-3, sin horario de verano) como instante. */
const mendoza = (date: string, time: string) => new Date(`${date}T${time}:00-03:00`);

function attention(
  now: Date,
  overrides: Partial<{
    blocks: AttentionHoursBlock[];
    holidays: string[];
    worksOnHolidays: boolean;
    timeZone: string;
  }> = {},
): HumanAttention {
  return nextHumanAttention({
    now,
    timeZone: overrides.timeZone ?? MENDOZA,
    blocks: overrides.blocks ?? WEEKDAYS,
    holidays: overrides.holidays ?? [],
    worksOnHolidays: overrides.worksOnHolidays ?? false,
  });
}

// 2026-10-09 es viernes: el 12/10 es lunes, el 10 y el 11 son fin de semana.
describe('nextHumanAttention: cuándo puede responder una persona (4.8)', () => {
  describe('dentro del horario', () => {
    it('a media mañana de un día de atención, está dentro', () => {
      expect(attention(mendoza('2026-10-09', '10:00'))).toEqual({ kind: 'now' });
    });

    it('el inicio del bloque cuenta como dentro; el fin, no', () => {
      expect(attention(mendoza('2026-10-09', '09:00'))).toEqual({ kind: 'now' });
      expect(attention(mendoza('2026-10-09', '17:59'))).toEqual({ kind: 'now' });
      expect(attention(mendoza('2026-10-09', '18:00'))).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-12', '09:00'),
      });
    });
  });

  describe('fuera del horario', () => {
    it('antes de abrir, el próximo inicio es hoy', () => {
      expect(attention(mendoza('2026-10-09', '08:59'))).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-09', '09:00'),
      });
    });

    it('después de cerrar, el próximo inicio es el día siguiente que atiende', () => {
      expect(attention(mendoza('2026-10-07', '20:30'))).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-08', '09:00'),
      });
    });

    it('un fin de semana sin atención salta al lunes', () => {
      expect(attention(mendoza('2026-10-10', '11:00'))).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-12', '09:00'),
      });
      expect(attention(mendoza('2026-10-11', '23:59'))).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-12', '09:00'),
      });
    });

    it('con un horario partido, entre los dos bloques el próximo inicio es el segundo (aunque estén desordenados)', () => {
      const split: AttentionHoursBlock[] = [
        { weekday: 5, start: '16:00', end: '20:00' },
        { weekday: 5, start: '09:00', end: '13:00' },
      ];

      expect(attention(mendoza('2026-10-09', '14:00'), { blocks: split })).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-09', '16:00'),
      });
      expect(attention(mendoza('2026-10-09', '16:00'), { blocks: split })).toEqual({ kind: 'now' });
    });

    it('un negocio que solo atiende un día busca la semana que viene', () => {
      const onlyWednesday: AttentionHoursBlock[] = [{ weekday: 3, start: '10:00', end: '12:00' }];

      expect(attention(mendoza('2026-10-07', '12:00'), { blocks: onlyWednesday })).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-14', '10:00'),
      });
    });
  });

  describe('zona horaria', () => {
    it('el día se cuenta en la hora del negocio: las 02:00 UTC del sábado son las 23:00 del viernes en Mendoza', () => {
      expect(attention(new Date('2026-10-10T02:00:00Z'))).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-12', '09:00'),
      });
    });

    it('con horario de verano, el inicio sale de la regla de la zona y no de sumar horas a mano', () => {
      // En Nueva York el reloj se adelanta el domingo 8/3/2026 a las 2:00: las 9:00 de ese día son 13:00 UTC.
      const sunday: AttentionHoursBlock[] = [{ weekday: 7, start: '09:00', end: '12:00' }];

      expect(
        attention(new Date('2026-03-08T01:00:00Z'), { blocks: sunday, timeZone: 'America/New_York' }),
      ).toEqual({ kind: 'later', startsAt: new Date('2026-03-08T13:00:00Z') });
    });
  });

  describe('feriados', () => {
    it('si el negocio no trabaja feriados, un feriado no tiene atención aunque caiga en un día del horario', () => {
      expect(attention(mendoza('2026-10-09', '18:30'), { holidays: ['2026-10-12'] })).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-13', '09:00'),
      });
    });

    it('si hoy es feriado, ni siquiera dentro del horario hay atención', () => {
      expect(attention(mendoza('2026-10-09', '10:00'), { holidays: ['2026-10-09'] })).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-12', '09:00'),
      });
    });

    it('si el negocio trabaja feriados, el feriado cuenta como un día más', () => {
      expect(
        attention(mendoza('2026-10-09', '18:30'), { holidays: ['2026-10-12'], worksOnHolidays: true }),
      ).toEqual({ kind: 'later', startsAt: mendoza('2026-10-12', '09:00') });
      expect(
        attention(mendoza('2026-10-09', '10:00'), { holidays: ['2026-10-09'], worksOnHolidays: true }),
      ).toEqual({ kind: 'now' });
    });

    it('feriados seguidos: salta todos', () => {
      expect(attention(mendoza('2026-10-09', '18:30'), { holidays: ['2026-10-12', '2026-10-13'] })).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-14', '09:00'),
      });
    });
  });

  describe('sin horario o sin nada que encontrar', () => {
    it('sin bloques cargados, no se sabe', () => {
      expect(attention(mendoza('2026-10-09', '10:00'), { blocks: [] })).toEqual({ kind: 'unknown' });
    });

    it('busca hasta 14 días hacia adelante, inclusive', () => {
      const mondays: AttentionHoursBlock[] = [{ weekday: 1, start: '09:00', end: '18:00' }];
      const now = mendoza('2026-10-12', '19:00');

      expect(attention(now, { blocks: mondays, holidays: ['2026-10-19'] })).toEqual({
        kind: 'later',
        startsAt: mendoza('2026-10-26', '09:00'),
      });
      expect(attention(now, { blocks: mondays, holidays: ['2026-10-19', '2026-10-26'] })).toEqual({
        kind: 'unknown',
      });
    });

    it('ignora los bloques que no se pueden usar (día fuera de rango, hora inválida o fin antes del inicio)', () => {
      const broken: AttentionHoursBlock[] = [
        { weekday: 0, start: '09:00', end: '18:00' },
        { weekday: 8, start: '09:00', end: '18:00' },
        { weekday: 5, start: '9', end: '18:00' },
        { weekday: 5, start: '18:00', end: '09:00' },
        { weekday: 5, start: '10:00', end: '10:00' },
      ];

      expect(attention(mendoza('2026-10-09', '10:00'), { blocks: broken })).toEqual({ kind: 'unknown' });
      expect(
        attention(mendoza('2026-10-09', '10:00'), {
          blocks: [...broken, { weekday: 5, start: '09:00', end: '12:00' }],
        }),
      ).toEqual({ kind: 'now' });
    });
  });
});

describe('describeHumanAttention: cuándo le responde una persona, escrito para la clienta', () => {
  it('dentro del horario: "en este horario"', () => {
    expect(describeHumanAttention({ kind: 'now' }, MENDOZA)).toBe('en este horario');
  });

  it('fuera del horario: el día, la fecha y la hora, sin cero adelante ("el viernes 9/10 a las 9:00")', () => {
    expect(describeHumanAttention({ kind: 'later', startsAt: mendoza('2026-10-09', '09:00') }, MENDOZA)).toBe(
      'el viernes 9/10 a las 9:00',
    );
    expect(describeHumanAttention({ kind: 'later', startsAt: mendoza('2026-12-01', '16:30') }, MENDOZA)).toBe(
      'el martes 1/12 a las 16:30',
    );
  });

  it('sin horario cargado: "lo antes posible", sin prometer una hora', () => {
    expect(describeHumanAttention({ kind: 'unknown' }, MENDOZA)).toBe('lo antes posible');
  });
});
