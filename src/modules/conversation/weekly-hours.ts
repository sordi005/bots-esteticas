import type { WeeklyBlock } from '../scheduling/availability.js';
import { parseLocalTime } from '../../shared/time-zone.js';
import { weekdayName } from './format.js';

/**
 * El horario semanal escrito para la clienta (tema `horarios` de `consultar_informacion`):
 * "lunes a viernes de 9 a 13 y de 15 a 20; sábados de 9 a 13". Lo arma el código a partir
 * del horario cargado de las profesionales, para que el modelo no lo reconstruya.
 */

/** "9" si es en punto, "9:30" si no. */
function clock(time: string): string {
  const minutes = parseLocalTime(time);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return minute === 0 ? String(hour) : `${String(hour)}:${String(minute).padStart(2, '0')}`;
}

function joinWithAnd(items: string[]): string {
  const last = items.at(-1);
  if (items.length < 2 || last === undefined) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${last}`;
}

/** Los bloques de un día, en orden: "de 9 a 13 y de 15 a 20". */
function describeDay(blocksOfDay: WeeklyBlock[]): string {
  const sorted = [...blocksOfDay].sort((a, b) => parseLocalTime(a.start) - parseLocalTime(b.start));
  return joinWithAnd(sorted.map((block) => `de ${clock(block.start)} a ${clock(block.end)}`));
}

/** "sábados": un día suelto va en plural ("lunes" ya lo está). */
function plural(weekday: number): string {
  const name = weekdayName(weekday);
  return name.endsWith('s') ? name : `${name}s`;
}

function describeDays(first: number, last: number): string {
  if (first === last) return plural(first);
  if (last === first + 1) return `${weekdayName(first)} y ${weekdayName(last)}`;
  return `${weekdayName(first)} a ${weekdayName(last)}`;
}

export function describeWeeklyHours(blocks: WeeklyBlock[]): string {
  // Cada día queda con su horario escrito; los días seguidos con el mismo se juntan.
  const runs: { first: number; last: number; hours: string }[] = [];
  for (let weekday = 1; weekday <= 7; weekday++) {
    const blocksOfDay = blocks.filter((block) => block.weekday === weekday);
    if (blocksOfDay.length === 0) continue;

    const hours = describeDay(blocksOfDay);
    const previous = runs.at(-1);
    if (previous?.last === weekday - 1 && previous.hours === hours) {
      previous.last = weekday;
    } else {
      runs.push({ first: weekday, last: weekday, hours });
    }
  }
  return runs.map((run) => `${describeDays(run.first, run.last)} ${run.hours}`).join('; ');
}

/**
 * Todas las profesionales con el mismo horario: se dice una sola vez. Si difieren, una línea
 * por profesional. Las que no tienen horario cargado no aparecen.
 */
export function describeTeamHours(team: { name: string; blocks: WeeklyBlock[] }[]): string {
  const described = team
    .map(({ name, blocks }) => ({ name, text: describeWeeklyHours(blocks) }))
    .filter(({ text }) => text !== '');

  const first = described[0];
  if (!first) return '';
  if (described.every(({ text }) => text === first.text)) return first.text;
  return described.map(({ name, text }) => `${name}: ${text}`).join('\n');
}
