import { instantToLocal, isoWeekday, type LocalDate } from '../../shared/time-zone.js';

/**
 * Textos que ve la clienta (6.4): los precios y las fechas los escribe el código, en español
 * rioplatense y en la zona horaria del negocio. El modelo no hace cuentas ni convierte horarios.
 */

/** Nombres de los días, 1 = lunes … 7 = domingo (ISO 8601). */
const WEEKDAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const SHORT_WEEKDAY_NAMES = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

export function weekdayName(weekday: number): string {
  const name = WEEKDAY_NAMES[weekday - 1];
  if (!name) throw new RangeError(`Día de la semana inválido: ${String(weekday)}`);
  return name;
}

function shortWeekdayName(weekday: number): string {
  const name = SHORT_WEEKDAY_NAMES[weekday - 1];
  if (!name) throw new RangeError(`Día de la semana inválido: ${String(weekday)}`);
  return name;
}

/** "$18.000": los precios están en centavos. Los centavos solo se muestran si los hay. */
export function formatPesos(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new RangeError(`Cantidad de centavos inválida: ${String(cents)}`);
  }
  const pesos = Math.floor(cents / 100).toString();
  const remainder = cents % 100;
  const grouped = pesos.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return remainder === 0 ? `$${grouped}` : `$${grouped},${String(remainder).padStart(2, '0')}`;
}

/** "9/10" (día/mes, sin ceros adelante) y "15:30" (la hora sin cero adelante: "9:00"). */
function dayAndMonth(date: LocalDate): string {
  const [, month = '', day = ''] = date.split('-');
  return `${String(Number(day))}/${String(Number(month))}`;
}

function clockTime(time: string): string {
  const [hour = '', minute = ''] = time.split(':');
  return `${String(Number(hour))}:${minute}`;
}

/** "viernes 9/10 15:30". */
export function formatLocalSlot(instant: Date, timeZone: string): string {
  const local = instantToLocal(instant, timeZone);
  return `${weekdayName(local.weekday)} ${dayAndMonth(local.date)} ${clockTime(local.time)}`;
}

/** "vie 9/10 15:30": entra en el título de un botón o de una fila de lista (20 caracteres). */
export function formatShortSlot(instant: Date, timeZone: string): string {
  const local = instantToLocal(instant, timeZone);
  return `${shortWeekdayName(local.weekday)} ${dayAndMonth(local.date)} ${clockTime(local.time)}`;
}

/** "lunes 12/10": un día cargado como AAAA-MM-DD. */
export function formatLocalDate(date: LocalDate): string {
  return `${weekdayName(isoWeekday(date))} ${dayAndMonth(date)}`;
}

/**
 * Acorta `text` a `max` caracteres para un título de botón o fila de lista: corta en el
 * límite de una palabra y agrega "…". Una palabra sola más larga que el límite se corta en seco.
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const lastSpace = room.lastIndexOf(' ');
  const cut = lastSpace > 0 ? room.slice(0, lastSpace) : room;
  return `${cut.trimEnd()}…`;
}
