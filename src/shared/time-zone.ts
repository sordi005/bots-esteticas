/**
 * Conversión entre hora local de un negocio y un instante UTC, con `Intl` (sin dependencias).
 *
 * - Fecha local: "AAAA-MM-DD". Hora local: "HH:MM" o "HH:MM:SS" (como una columna `time`).
 * - Días de la semana ISO 8601: 1 = lunes … 7 = domingo.
 */
export type LocalDate = string;
export type LocalTime = string;

export interface LocalDateTime {
  date: LocalDate;
  /** "HH:MM" */
  time: string;
  minutesOfDay: number;
  weekday: number;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const HALF_DAY_MS = 12 * 60 * 60 * 1000;

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseLocalDate(date: LocalDate): DateParts {
  const match = DATE_PATTERN.exec(date);
  const [year, month, day] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    !match ||
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new Error(`Fecha inválida: "${date}" (se espera AAAA-MM-DD)`);
  }
  return { year, month, day };
}

function parseTimeParts(time: LocalTime): { hour: number; minute: number; second: number } {
  const match = TIME_PATTERN.exec(time);
  if (!match) {
    throw new Error(`Hora inválida: "${time}" (se espera HH:MM)`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] ?? 0) };
}

/** Minutos desde la medianoche. Los segundos se ignoran. */
export function parseLocalTime(time: LocalTime): number {
  const { hour, minute } = parseTimeParts(time);
  return hour * 60 + minute;
}

function formatUtcDate(date: Date): LocalDate {
  return date.toISOString().slice(0, 10);
}

export function addDaysToLocalDate(date: LocalDate, days: number): LocalDate {
  const { year, month, day } = parseLocalDate(date);
  return formatUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

export function isoWeekday(date: LocalDate): number {
  const { year, month, day } = parseLocalDate(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** La hora de pared de `instant` en `timeZone`, expresada como si fuera UTC (en ms). */
function wallClockMs(instant: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
}

/** Diferencia entre la hora de pared y UTC en ese instante (Mendoza: -3 h). */
function offsetMs(instant: Date, timeZone: string): number {
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return wallClockMs(instant, timeZone) - wholeSeconds;
}

/**
 * Instante UTC de una fecha y hora locales.
 * Con horario de verano: una hora que se repite toma la primera vez; una hora que no
 * existe (el reloj la salta) se corre hacia adelante lo que dura el salto.
 */
export function localDateTimeToInstant(date: LocalDate, time: LocalTime, timeZone: string): Date {
  const { year, month, day } = parseLocalDate(date);
  const { hour, minute, second } = parseTimeParts(time);
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);

  // Los offsets posibles son el de antes y el de después de un eventual cambio de hora.
  const offsetBefore = offsetMs(new Date(wallMs - HALF_DAY_MS), timeZone);
  const offsetAfter = offsetMs(new Date(wallMs + HALF_DAY_MS), timeZone);

  const matching = [wallMs - offsetBefore, wallMs - offsetAfter]
    .filter((candidate) => wallClockMs(new Date(candidate), timeZone) === wallMs)
    .sort((a, b) => a - b);

  return new Date(matching[0] ?? wallMs - offsetBefore);
}

export function instantToLocal(instant: Date, timeZone: string): LocalDateTime {
  const wall = new Date(wallClockMs(instant, timeZone));
  const date = formatUtcDate(wall);
  const minutesOfDay = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  return {
    date,
    time: wall.toISOString().slice(11, 16),
    minutesOfDay,
    weekday: isoWeekday(date),
  };
}
