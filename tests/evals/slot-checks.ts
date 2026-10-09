import { parseChoiceId } from '../../src/modules/conversation/tools/choice-ids.js';
import { instantToLocal, type LocalDate } from '../../src/shared/time-zone.js';
import type { EvalResult } from './evaluate.js';

/**
 * Chequeos con código sobre los horarios que ofreció el agente (`verifica` de los casos de
 * disponibilidad). Leen los ids de las opciones con `parseChoiceId` y convierten a hora local
 * con `instantToLocal`: nunca se confía en lo que dice el texto de la respuesta.
 */

interface OfferedSlot {
  start: Date;
  /** Fecha y hora locales del negocio, para los mensajes de error. */
  local: { date: LocalDate; time: string; minutesOfDay: number };
  /** Cómo quedó después de volver a resolver la opción contra la base (`resolveChoice`). */
  stillFree: boolean;
}

/** Las opciones `horario:` del mensaje; "Ver otros horarios" y los servicios no cuentan. */
function offeredSlots(result: EvalResult, timeZone: string): OfferedSlot[] {
  const slots: OfferedSlot[] = [];
  for (const option of result.opciones) {
    const choice = parseChoiceId(option.id);
    if (choice?.kind !== 'slot') continue;
    slots.push({
      start: choice.start,
      local: instantToLocal(choice.start, timeZone),
      stillFree: option.resuelta?.tipo === 'horario' && option.resuelta.sigueLibre,
    });
  }
  return slots;
}

const label = (slot: OfferedSlot) => `${slot.local.date} ${slot.local.time}`;

/**
 * Hay al menos un horario, todos del día `date` (hora local) y de `fromMinutes` en adelante
 * (minutos desde la medianoche local), y todos siguen libres según la base.
 */
export function verifySlotsOnDayFrom(
  result: EvalResult,
  expected: { date: LocalDate; fromMinutes: number },
  timeZone: string,
): string | null {
  const slots = offeredSlots(result, timeZone);
  if (slots.length === 0) return 'No ofreció ningún horario';

  const from = `${String(Math.floor(expected.fromMinutes / 60)).padStart(2, '0')}:${String(expected.fromMinutes % 60).padStart(2, '0')}`;
  for (const slot of slots) {
    if (slot.local.date !== expected.date || slot.local.minutesOfDay < expected.fromMinutes) {
      return `Horario fuera de lo pedido: ${label(slot)} (hora local); se pedía ${expected.date} desde las ${from}`;
    }
    if (!slot.stillFree) return `El horario ${label(slot)} (hora local) no está libre según la base`;
  }
  return null;
}

/** Ningún horario ofrecido cae en el día `date` (hora local). Ofrecer de otros días está bien. */
export function verifyNoSlotsOnDay(result: EvalResult, date: LocalDate, timeZone: string): string | null {
  const onDay = offeredSlots(result, timeZone).find((slot) => slot.local.date === date);
  return onDay ? `Ofreció un horario el ${date} (${label(onDay)}, hora local)` : null;
}
