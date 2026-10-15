import { describe, expect, it } from 'vitest';
import type { Slot } from '../../../src/modules/scheduling/availability.js';
import {
  MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES,
  pickNearestSlots,
  pickSpreadSlots,
} from '../../../src/modules/scheduling/slot-selection.js';
import { instantToLocal, localDateTimeToInstant } from '../../../src/shared/time-zone.js';

const MENDOZA = 'America/Argentina/Mendoza';
const MINUTE_MS = 60_000;

function slotStartingAt(start: Date, professionalId = 'mica'): Slot {
  return {
    professionalId,
    start,
    end: new Date(start.getTime() + 60 * MINUTE_MS),
    occupiedUntil: new Date(start.getTime() + 70 * MINUTE_MS),
  };
}

/** Un horario de 60 minutos, hora de Mendoza. Por defecto, el lunes 5/10/2026. */
function slotAt(time: string, professionalId = 'mica', date = '2026-10-05'): Slot {
  return slotStartingAt(localDateTimeToInstant(date, time, MENDOZA), professionalId);
}

/** Horarios cada 15 minutos del lunes 5/10, de `from` (incluido) a `to` (excluido). */
function everyQuarterHour(from: string, to: string): Slot[] {
  const slots: Slot[] = [];
  const end = localDateTimeToInstant('2026-10-05', to, MENDOZA).getTime();
  for (
    let start = localDateTimeToInstant('2026-10-05', from, MENDOZA).getTime();
    start < end;
    start += 15 * MINUTE_MS
  ) {
    slots.push(slotStartingAt(new Date(start)));
  }
  return slots;
}

/** La hora local de cada horario: así los tests se leen como la agenda de Mendoza. */
const localTimes = (slots: Slot[]) => slots.map((slot) => instantToLocal(slot.start, MENDOZA).time);

describe('pickSpreadSlots: las opciones las elige el código (4.3)', () => {
  it('la separación por defecto es la de la especificación: 90 minutos', () => {
    expect(MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES).toBe(90);
  });

  it('con horarios cada 15 minutos ofrece 9:00, 10:30 y 12:00, no 9:00, 9:15 y 9:30', () => {
    const { chosen } = pickSpreadSlots(everyQuarterHour('09:00', '13:00'), {
      count: 3,
      minGapMinutes: MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES,
    });

    expect(localTimes(chosen)).toEqual(['09:00', '10:30', '12:00']);
  });

  it('acepta justo la separación mínima y rechaza un minuto menos', () => {
    const { chosen } = pickSpreadSlots([slotAt('09:00'), slotAt('10:29'), slotAt('10:30')], {
      count: 2,
      minGapMinutes: 90,
    });

    expect(localTimes(chosen)).toEqual(['09:00', '10:30']);
  });

  it('mide la separación desde la última opción elegida, no desde el horario anterior', () => {
    const slots = ['09:00', '10:00', '10:30', '11:00', '12:00'].map((time) => slotAt(time));

    const { chosen } = pickSpreadSlots(slots, { count: 3, minGapMinutes: 90 });

    // 10:00 está a 60 min de 9:00; 11:00 está a 30 min de 10:30.
    expect(localTimes(chosen)).toEqual(['09:00', '10:30', '12:00']);
  });

  it('indica que hay más cuando quedan horarios después del último elegido', () => {
    const result = pickSpreadSlots(everyQuarterHour('09:00', '13:00'), { count: 3, minGapMinutes: 90 });
    expect(result.hasMore).toBe(true);
  });

  it('no hay más cuando el último elegido es el último horario libre', () => {
    const result = pickSpreadSlots([slotAt('09:00'), slotAt('10:30'), slotAt('12:00')], {
      count: 3,
      minGapMinutes: 90,
    });

    expect(localTimes(result.chosen)).toEqual(['09:00', '10:30', '12:00']);
    expect(result.hasMore).toBe(false);
  });

  it('con menos horarios que opciones, ofrece los que hay', () => {
    const result = pickSpreadSlots([slotAt('09:00'), slotAt('12:00')], { count: 3, minGapMinutes: 90 });

    expect(localTimes(result.chosen)).toEqual(['09:00', '12:00']);
    expect(result.hasMore).toBe(false);
  });

  it('si los horarios que quedan están muy cerca de la última opción, igual hay más para ver', () => {
    const result = pickSpreadSlots([slotAt('09:00'), slotAt('09:30')], { count: 3, minGapMinutes: 90 });

    expect(localTimes(result.chosen)).toEqual(['09:00']);
    expect(result.hasMore).toBe(true);
  });

  it('sin horarios no ofrece nada ni hay más', () => {
    expect(pickSpreadSlots([], { count: 3, minGapMinutes: 90 })).toEqual({ chosen: [], hasMore: false });
  });

  it('con una sola opción pedida devuelve la primera libre', () => {
    const result = pickSpreadSlots(everyQuarterHour('09:00', '10:00'), { count: 1, minGapMinutes: 90 });

    expect(localTimes(result.chosen)).toEqual(['09:00']);
    expect(result.hasMore).toBe(true);
  });

  it('con separación cero ofrece los primeros horarios seguidos', () => {
    const { chosen } = pickSpreadSlots(everyQuarterHour('09:00', '10:00'), { count: 3, minGapMinutes: 0 });
    expect(localTimes(chosen)).toEqual(['09:00', '09:15', '09:30']);
  });

  it('devuelve los mismos horarios que recibió, con su profesional', () => {
    const sofi = slotAt('09:00', 'sofi');
    const mica = slotAt('11:00', 'mica');

    const { chosen } = pickSpreadSlots([sofi, mica], { count: 2, minGapMinutes: 90 });

    expect(chosen[0]).toBe(sofi);
    expect(chosen[1]).toBe(mica);
  });

  it('un horario de otro día siempre cumple la separación', () => {
    const { chosen } = pickSpreadSlots([slotAt('19:30'), slotAt('09:00', 'mica', '2026-10-06')], {
      count: 2,
      minGapMinutes: 90,
    });

    expect(chosen).toHaveLength(2);
  });

  it('rechaza una cantidad de opciones o una separación que no tienen sentido', () => {
    expect(() => pickSpreadSlots([], { count: 0, minGapMinutes: 90 })).toThrow(RangeError);
    expect(() => pickSpreadSlots([], { count: 2.5, minGapMinutes: 90 })).toThrow(RangeError);
    expect(() => pickSpreadSlots([], { count: 3, minGapMinutes: -1 })).toThrow(RangeError);
  });
});

describe('pickNearestSlots: las alternativas más cercanas a la hora que pidió la clienta', () => {
  const target = localDateTimeToInstant('2026-10-05', '16:30', MENDOZA);
  const slotsAt = (...times: string[]) => times.map((time) => slotAt(time));
  const nearest = (slots: Slot[], options: { count?: number; minGapMinutes?: number } = {}) =>
    localTimes(pickNearestSlots(slots, { target, count: 3, minGapMinutes: 90, ...options }));

  it('elige primero el más cercano y después los que siguen más cerca, separados por 90 minutos', () => {
    // 16:45 es el más cercano; 17:00 queda a 15 minutos de él y no se ofrece; 15:15 está a 90 minutos.
    expect(nearest(slotsAt('15:00', '15:15', '16:45', '17:00', '18:30', '19:00'))).toEqual(['15:15', '16:45', '18:30']);
  });

  it('devuelve los horarios ordenados por inicio, no por cercanía', () => {
    expect(nearest(slotsAt('18:30', '16:45', '15:15'))).toEqual(['15:15', '16:45', '18:30']);
  });

  it('a igual distancia, el más temprano', () => {
    // 16:00 y 17:00 están a 30 minutos de las 16:30: con una sola opción, el de antes.
    expect(nearest(slotsAt('17:00', '16:00'), { count: 1 })).toEqual(['16:00']);
  });

  it('con horarios cada 15 minutos alrededor, una opción a cada lado y no tres seguidas', () => {
    const everyQuarter = everyQuarterHour('14:00', '19:00').filter((slot) => localTimes([slot])[0] !== '16:30');

    // 16:15 y 16:45 están igual de cerca: queda el de antes; de ahí, 90 minutos para cada lado.
    expect(nearest(everyQuarter)).toEqual(['14:45', '16:15', '17:45']);
  });

  it('con separación cero son simplemente los más cercanos', () => {
    expect(nearest(slotsAt('16:00', '16:15', '16:45', '17:00'), { minGapMinutes: 0, count: 3 })).toEqual([
      '16:00',
      '16:15',
      '16:45',
    ]);
  });

  it('no inventa horarios: devuelve menos si no hay tantos, y nada si no hay ninguno', () => {
    expect(nearest(slotsAt('16:45', '17:00'))).toEqual(['16:45']);
    expect(nearest([])).toEqual([]);
  });

  it('respeta la cantidad pedida', () => {
    expect(nearest(slotsAt('09:00', '11:00', '13:00', '15:00', '18:30'), { count: 2 })).toEqual(['15:00', '18:30']);
  });

  it('devuelve los mismos horarios que recibió, con su profesional, y no modifica la lista', () => {
    const sofi = slotAt('16:45', 'sofi');
    const mica = slotAt('15:00', 'mica');
    const input = [sofi, mica];

    const chosen = pickNearestSlots(input, { target, count: 2, minGapMinutes: 90 });

    expect(chosen[0]).toBe(mica);
    expect(chosen[1]).toBe(sofi);
    expect(input).toEqual([sofi, mica]);
  });

  it('rechaza una cantidad o una separación que no tienen sentido', () => {
    expect(() => pickNearestSlots([], { target, count: 0, minGapMinutes: 90 })).toThrow(RangeError);
    expect(() => pickNearestSlots([], { target, count: 3, minGapMinutes: -1 })).toThrow(RangeError);
  });
});
