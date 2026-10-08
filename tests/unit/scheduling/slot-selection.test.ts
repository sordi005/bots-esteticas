import { describe, expect, it } from 'vitest';
import type { Slot } from '../../../src/modules/scheduling/availability.js';
import {
  MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES,
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
