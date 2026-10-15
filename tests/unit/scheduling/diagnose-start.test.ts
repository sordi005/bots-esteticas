import { describe, expect, it } from 'vitest';
import {
  alignToClock,
  diagnoseStart,
  findAvailableSlots,
  nearestGridStart,
  type AvailabilityQuery,
  type ProfessionalSchedule,
  type WeeklyBlock,
} from '../../../src/modules/scheduling/availability.js';
import { instantToLocal, localDateTimeToInstant } from '../../../src/shared/time-zone.js';

const MENDOZA = 'America/Argentina/Mendoza';

// Octubre de 2026: el 4 es domingo, el 5 lunes, el 12 lunes y feriado.
const at = (date: string, time: string) => localDateTimeToInstant(date, time, MENDOZA);
const range = (date: string, start: string, end: string) => ({ start: at(date, start), end: at(date, end) });

const weekly = (weekdays: number[], start: string, end: string): WeeklyBlock[] =>
  weekdays.map((weekday) => ({ weekday, start, end }));

// Mica: lunes a viernes de 9 a 13 y de 15 a 20 (horario partido).
const MICA_HOURS = [...weekly([1, 2, 3, 4, 5], '09:00', '13:00'), ...weekly([1, 2, 3, 4, 5], '15:00', '20:00')];

const mica = (overrides: Partial<ProfessionalSchedule> = {}): ProfessionalSchedule => ({
  id: 'mica',
  weeklyHours: MICA_HOURS,
  busy: [],
  ...overrides,
});

/** Semipermanente: 60 minutos más 10 de margen. Hoy es el domingo 4/10 a las 9:00. */
function query(overrides: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    now: at('2026-10-04', '09:00'),
    timeZone: MENDOZA,
    // La ventana no importa: se mira el inicio pedido, no la ventana de la consulta.
    window: { start: at('2026-10-05', '00:00'), end: at('2026-10-06', '00:00') },
    service: { durationMinutes: 60, bufferMinutes: 10 },
    professionals: [mica()],
    exceptions: [],
    holidays: [],
    worksOnHolidays: false,
    rules: { slotGranularityMinutes: 15, minBookingNoticeMinutes: 120, maxBookingAdvanceDays: 30 },
    ...overrides,
  };
}

const kindAt = (date: string, time: string, q: AvailabilityQuery = query(), professional = mica()) =>
  diagnoseStart(q, professional, at(date, time)).kind;

describe('diagnoseStart: un horario puntual', () => {
  describe('libre', () => {
    it('un horario que la reserva aceptaría es libre y trae el turno con su inicio, su fin y lo que ocupa', () => {
      const verdict = diagnoseStart(query(), mica(), at('2026-10-05', '16:30'));

      expect(verdict).toEqual({
        kind: 'free',
        slot: {
          professionalId: 'mica',
          start: at('2026-10-05', '16:30'),
          end: at('2026-10-05', '17:30'),
          occupiedUntil: at('2026-10-05', '17:40'),
        },
      });
    });

    it('usa la duración propia de la profesional', () => {
      const verdict = diagnoseStart(query(), mica({ durationOverrideMinutes: 75 }), at('2026-10-05', '16:30'));

      expect(verdict).toMatchObject({ kind: 'free', slot: { end: at('2026-10-05', '17:45') } });
    });

    it('el margen puede quedar después del cierre, pero la duración no', () => {
      expect(kindAt('2026-10-05', '12:00')).toBe('free');
      expect(kindAt('2026-10-05', '12:15')).toBe('outside_hours');
    });
  });

  describe('ocupado', () => {
    it('un turno que se superpone con el horario lo deja ocupado', () => {
      const busy = [range('2026-10-05', '16:00', '17:10')];

      expect(kindAt('2026-10-05', '16:30', query(), mica({ busy }))).toBe('taken');
    });

    it('el margen del turno propio también cuenta: no puede empezar donde pisaría al turno siguiente', () => {
      const busy = [range('2026-10-05', '17:20', '18:30')];

      // 16:30 más 60 minutos de duración y 10 de margen llega hasta las 17:40, y el otro turno empieza 17:20.
      expect(kindAt('2026-10-05', '16:30', query(), mica({ busy }))).toBe('taken');
      expect(kindAt('2026-10-05', '16:00', query(), mica({ busy }))).toBe('free');
    });

    it('un horario ocupado y fuera de la grilla es de la grilla: no hay horario que ocupar', () => {
      const busy = [range('2026-10-05', '16:00', '17:10')];

      expect(kindAt('2026-10-05', '16:20', query(), mica({ busy }))).toBe('off_grid');
    });
  });

  describe('fuera de la grilla', () => {
    it.each(['16:20', '16:01', '09:50'])('%s no es un inicio de turno con granularidad de 15 minutos', (time) => {
      expect(kindAt('2026-10-05', time)).toBe('off_grid');
    });

    it('con otra granularidad cambia la grilla', () => {
      const thirty = query({ rules: { slotGranularityMinutes: 30, minBookingNoticeMinutes: 120, maxBookingAdvanceDays: 30 } });

      expect(kindAt('2026-10-05', '16:15', thirty)).toBe('off_grid');
      expect(kindAt('2026-10-05', '16:30', thirty)).toBe('free');
    });
  });

  describe('fuera del horario', () => {
    it.each(['08:45', '14:00', '19:15', '21:00', '03:00'])(
      '%s del lunes no está dentro de ningún bloque de trabajo',
      (time) => {
        // Las 3:00 también pasan la anticipación: es el lunes, hoy es domingo.
        expect(kindAt('2026-10-05', time)).toBe('outside_hours');
      },
    );

    it('un bloque cortado por un cierre cargado deja ese rato fuera del horario', () => {
      const closed = query({
        exceptions: [{ professionalId: 'mica', kind: 'closed', range: range('2026-10-05', '16:00', '17:30') }],
      });

      expect(kindAt('2026-10-05', '16:30', closed)).toBe('outside_hours');
      expect(kindAt('2026-10-05', '18:00', closed)).toBe('free');
    });

    it('un horario especial de una profesional reemplaza su horario semanal de ese día', () => {
      const special = query({
        exceptions: [{ professionalId: 'mica', kind: 'special_hours', range: range('2026-10-05', '10:00', '14:00') }],
      });

      expect(kindAt('2026-10-05', '10:30', special)).toBe('free');
      expect(kindAt('2026-10-05', '16:30', special)).toBe('outside_hours');
    });
  });

  describe('día cerrado y feriado', () => {
    it('un día sin horario semanal es un día cerrado, no un horario fuera de bloque', () => {
      // Domingo 11/10: la profesional no trabaja.
      expect(kindAt('2026-10-11', '10:00')).toBe('closed_day');
    });

    it('un cierre de todo el día cargado como excepción es un día cerrado', () => {
      const closed = query({
        exceptions: [{ professionalId: null, kind: 'closed', range: range('2026-10-06', '00:00', '23:59') }],
      });

      expect(kindAt('2026-10-06', '10:00', closed)).toBe('closed_day');
      expect(kindAt('2026-10-07', '10:00', closed)).toBe('free');
    });

    it('un feriado en que el negocio no trabaja es un feriado', () => {
      const holiday = query({ holidays: ['2026-10-12'] });

      expect(kindAt('2026-10-12', '16:30', holiday)).toBe('holiday');
      expect(kindAt('2026-10-13', '16:30', holiday)).toBe('free');
    });

    it('si el negocio trabaja los feriados, el feriado es un día común', () => {
      const works = query({ holidays: ['2026-10-12'], worksOnHolidays: true });

      expect(kindAt('2026-10-12', '16:30', works)).toBe('free');
    });

    it('un feriado que el negocio abre con un horario especial se abre solo en ese rango', () => {
      const opened = query({
        holidays: ['2026-10-12'],
        exceptions: [{ professionalId: null, kind: 'special_hours', range: range('2026-10-12', '15:00', '18:00') }],
      });

      expect(kindAt('2026-10-12', '16:00', opened)).toBe('free');
      expect(kindAt('2026-10-12', '19:00', opened)).toBe('outside_hours');
    });
  });

  describe('anticipación', () => {
    it('sin la anticipación mínima: faltan menos de 2 horas', () => {
      const now = query({ now: at('2026-10-05', '08:00') });

      expect(kindAt('2026-10-05', '09:30', now)).toBe('too_soon');
      // Justo con la anticipación mínima, sí.
      expect(kindAt('2026-10-05', '10:00', now)).toBe('free');
    });

    it('un horario que ya pasó cuenta como sin la anticipación mínima', () => {
      const now = query({ now: at('2026-10-05', '17:00') });

      expect(kindAt('2026-10-05', '16:30', now)).toBe('too_soon');
    });

    it('más allá de la anticipación máxima: 30 días', () => {
      // Hoy es domingo 4/10 a las 9:00: el límite es el martes 3/11 a las 9:00.
      expect(kindAt('2026-11-03', '09:00')).toBe('free');
      expect(kindAt('2026-11-03', '09:15')).toBe('too_far');
      expect(kindAt('2026-11-10', '16:30')).toBe('too_far');
    });

    it('la anticipación gana sobre el horario: no tiene sentido decir "fuera de horario" de algo que ya pasó', () => {
      const now = query({ now: at('2026-10-05', '17:00') });

      expect(kindAt('2026-10-05', '03:00', now)).toBe('too_soon');
      expect(kindAt('2026-12-14', '03:00')).toBe('too_far');
    });
  });

  it('para cualquier inicio del día coincide con lo que ofrece findAvailableSlots, con y sin turnos tomados', () => {
    const busy = [range('2026-10-05', '10:00', '11:10'), range('2026-10-05', '16:00', '17:10')];
    const q = query({
      professionals: [mica({ busy })],
      exceptions: [{ professionalId: null, kind: 'closed', range: range('2026-10-05', '18:00', '18:30') }],
    });
    const offered = new Set(
      findAvailableSlots({ ...q, window: { start: at('2026-10-05', '00:00'), end: at('2026-10-06', '00:00') } }).map((slot) =>
        slot.start.getTime(),
      ),
    );

    for (let minutes = 0; minutes < 24 * 60; minutes += 5) {
      const start = new Date(at('2026-10-05', '00:00').getTime() + minutes * 60_000);
      const verdict = diagnoseStart(q, mica({ busy }), start);
      const label = instantToLocal(start, MENDOZA).time;

      expect(verdict.kind === 'free', label).toBe(offered.has(start.getTime()));
    }
  });
});

describe('nearestGridStart: la hora de la grilla más cercana', () => {
  const nearest = (time: string, granularity = 15) =>
    instantToLocal(nearestGridStart(at('2026-10-05', time), granularity, MENDOZA), MENDOZA).time;

  it('redondea hacia la marca más cercana', () => {
    expect(nearest('16:20')).toBe('16:15');
    expect(nearest('16:25')).toBe('16:30');
    expect(nearest('16:01')).toBe('16:00');
    expect(nearest('16:59')).toBe('17:00');
  });

  it('una hora que ya está en la grilla no se mueve', () => {
    expect(nearest('16:30')).toBe('16:30');
  });

  it('si queda a mitad de camino, va a la siguiente', () => {
    expect(nearest('16:15', 30)).toBe('16:30');
  });

  it('con otra granularidad usa esa grilla', () => {
    expect(nearest('16:20', 30)).toBe('16:30');
    expect(nearest('16:40', 20)).toBe('16:40');
  });
});

describe('alignToClock: el primer inicio de la grilla desde un instante', () => {
  const next = (time: string, granularity = 15) =>
    instantToLocal(new Date(alignToClock(at('2026-10-05', time).getTime(), granularity, MENDOZA)), MENDOZA).time;

  it('sube a la marca siguiente y no se mueve si ya está en la grilla', () => {
    expect(next('10:07')).toBe('10:15');
    expect(next('10:15')).toBe('10:15');
    expect(next('10:46')).toBe('11:00');
  });

  it('con otra granularidad usa esa grilla', () => {
    expect(next('10:07', 30)).toBe('10:30');
  });
});
