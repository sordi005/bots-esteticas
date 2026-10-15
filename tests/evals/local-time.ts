import { instantToLocal, localDateTimeToInstant } from '../../src/shared/time-zone.js';

/**
 * Las fechas de los casos de evaluación se escriben en hora local del negocio, "AAAA-MM-DD HH:MM"
 * ("2026-10-13 17:00"): así se leen igual que en la conversación. Acá se pasan de ida y vuelta
 * al instante UTC; la conversión la hace siempre `shared/time-zone.ts`.
 */
const LOCAL_START = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/;

export function parseLocalStart(text: string, timeZone: string): Date {
  const match = LOCAL_START.exec(text);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Fecha y hora inválidas: "${text}" (se espera AAAA-MM-DD HH:MM, en hora local)`);
  }
  return localDateTimeToInstant(match[1], match[2], timeZone);
}

export function formatLocalStart(instant: Date, timeZone: string): string {
  const local = instantToLocal(instant, timeZone);
  return `${local.date} ${local.time}`;
}
