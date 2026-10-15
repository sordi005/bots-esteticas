import {
  addDaysToLocalDate,
  instantToLocal,
  isoWeekday,
  localDateTimeToInstant,
  parseLocalTime,
  type LocalDate,
} from '../../shared/time-zone.js';
import type { AttentionHoursBlock } from '../tenants/schema.js';
import { formatClockTime, formatLocalDate } from './format.js';

/**
 * Horario de atención humana (4.8): cuándo puede responder una persona del negocio. Sirve para
 * decirle a la clienta cuándo le van a contestar después de una derivación. Es una función pura:
 * recibe la hora actual, la zona del negocio, el horario cargado y los feriados.
 */

/** [S] Cuántos días hacia adelante se busca el próximo horario de atención (el de hoy es el día 0). */
export const ATTENTION_SEARCH_DAYS = 14;

export type HumanAttention =
  /** Ahora hay atención. */
  | { kind: 'now' }
  /** Ahora no; la próxima atención empieza en `startsAt`. */
  | { kind: 'later'; startsAt: Date }
  /** Sin horario cargado (o sin atención en los próximos días): no se promete una hora. */
  | { kind: 'unknown' };

export interface AttentionInput {
  now: Date;
  /** Zona horaria del negocio. */
  timeZone: string;
  blocks: readonly AttentionHoursBlock[];
  /** Fechas de feriado "AAAA-MM-DD" (tabla global `holidays`). Alcanza con las de los próximos 14 días. */
  holidays: readonly LocalDate[];
  /** Si el negocio no trabaja feriados, un feriado no tiene atención. */
  worksOnHolidays: boolean;
}

interface UsableBlock {
  weekday: number;
  startMinutes: number;
  endMinutes: number;
  start: string;
}

/**
 * Los bloques que se pueden usar: el horario es un dato cargado a mano, y uno mal escrito
 * no puede romper una derivación. Se ignoran los de un día inexistente, con una hora inválida
 * o que no terminan después de empezar.
 */
function usableBlocks(blocks: readonly AttentionHoursBlock[]): UsableBlock[] {
  const usable: UsableBlock[] = [];
  for (const block of blocks) {
    if (!Number.isInteger(block.weekday) || block.weekday < 1 || block.weekday > 7) continue;
    try {
      const startMinutes = parseLocalTime(block.start);
      const endMinutes = parseLocalTime(block.end);
      if (endMinutes > startMinutes) {
        usable.push({ weekday: block.weekday, startMinutes, endMinutes, start: block.start });
      }
    } catch {
      continue;
    }
  }
  return usable.sort((a, b) => a.weekday - b.weekday || a.startMinutes - b.startMinutes);
}

export function nextHumanAttention(input: AttentionInput): HumanAttention {
  const blocks = usableBlocks(input.blocks);
  if (blocks.length === 0) return { kind: 'unknown' };

  const holidays = new Set(input.holidays);
  const local = instantToLocal(input.now, input.timeZone);

  for (let offset = 0; offset <= ATTENTION_SEARCH_DAYS; offset += 1) {
    const date = addDaysToLocalDate(local.date, offset);
    if (!input.worksOnHolidays && holidays.has(date)) continue;

    const weekday = isoWeekday(date);
    for (const block of blocks) {
      if (block.weekday !== weekday) continue;
      if (offset === 0) {
        if (local.minutesOfDay >= block.endMinutes) continue;
        if (local.minutesOfDay >= block.startMinutes) return { kind: 'now' };
      }
      return { kind: 'later', startsAt: localDateTimeToInstant(date, block.start, input.timeZone) };
    }
  }
  return { kind: 'unknown' };
}

/**
 * Cuándo le responde una persona, escrito por el código para completar una frase como "te va a
 * responder por acá {cuándo}" (6.4): el modelo no convierte horarios.
 */
export function describeHumanAttention(attention: HumanAttention, timeZone: string): string {
  switch (attention.kind) {
    case 'now':
      return 'en este horario';
    case 'later': {
      const local = instantToLocal(attention.startsAt, timeZone);
      return `el ${formatLocalDate(local.date)} a las ${formatClockTime(local.time)}`;
    }
    case 'unknown':
      return 'lo antes posible';
  }
}
