import { parseChoiceId } from '../../src/modules/conversation/tools/choice-ids.js';
import { instantToLocal, type LocalDate } from '../../src/shared/time-zone.js';
import { formatLocalStart } from './local-time.js';
import type { EvalResult } from './evaluate.js';

/**
 * Chequeos con código sobre los horarios que ofreció el agente (`verifica` de los casos de
 * disponibilidad). Leen los ids de las opciones con `parseChoiceId` y convierten a hora local
 * con `instantToLocal`: nunca se confía en lo que dice el texto de la respuesta.
 */

interface OfferedSlot {
  start: Date;
  /** La profesional del horario, tal como lo resolvió la base. Null si no se pudo resolver. */
  professional: string | null;
  /** Fecha y hora locales del negocio, para los mensajes de error. */
  local: { date: LocalDate; time: string; minutesOfDay: number };
  /** Cómo quedó después de volver a resolver la opción contra la base (`resolveChoice`). */
  stillFree: boolean;
}

/**
 * Las opciones `horario:` (para reservar) y `reprogramar:` (para mover un turno) del mensaje;
 * "Ver otros horarios" y los servicios no cuentan.
 */
function offeredSlots(result: EvalResult, timeZone: string): OfferedSlot[] {
  const slots: OfferedSlot[] = [];
  for (const option of result.opciones) {
    const choice = parseChoiceId(option.id);
    if (choice?.kind !== 'slot' && choice?.kind !== 'reschedule') continue;
    const resolved = option.resuelta;
    const known = resolved?.tipo === 'horario' || resolved?.tipo === 'reprogramar' ? resolved : null;
    slots.push({
      start: choice.start,
      professional: known?.profesionalNombre ?? null,
      local: instantToLocal(choice.start, timeZone),
      stillFree: known?.sigueLibre ?? false,
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

/** Hay al menos un horario y todos siguen libres según la base (de cualquier día y hora). */
export function verifyOffersFreeSlots(result: EvalResult, timeZone: string): string | null {
  const slots = offeredSlots(result, timeZone);
  if (slots.length === 0) return 'No ofreció ningún horario';
  const taken = slots.find((slot) => !slot.stillFree);
  return taken ? `El horario ${label(taken)} (hora local) no está libre según la base` : null;
}

/** Hay al menos un horario y todos son de esa profesional (por nombre, como la resolvió la base). */
export function verifySlotsOfProfessional(result: EvalResult, professional: string, timeZone: string): string | null {
  const slots = offeredSlots(result, timeZone);
  if (slots.length === 0) return 'No ofreció ningún horario';
  const other = slots.find((slot) => slot.professional !== professional);
  return other
    ? `Ofreció un horario con ${other.professional ?? 'una profesional que no se pudo resolver'} (${label(other)}, hora local) y se pedía ${professional}`
    : null;
}

/** No ofreció ese horario (inicio local "AAAA-MM-DD HH:MM") con esa profesional. A la misma hora con otra, sí se puede. */
export function verifySlotNotOffered(
  result: EvalResult,
  slot: { profesional: string; inicio: string },
  timeZone: string,
): string | null {
  const offered = offeredSlots(result, timeZone).find(
    (candidate) => candidate.professional === slot.profesional && formatLocalStart(candidate.start, timeZone) === slot.inicio,
  );
  return offered ? `Ofreció el horario ${slot.inicio} con ${slot.profesional}, que ya estaba ocupado` : null;
}

/**
 * Ofreció horarios para MOVER el turno (`reprogramar:`) y ninguno para reservar (`horario:`): la
 * intención va en el id (decisión 28). Cada uno se volvió a resolver contra la base, que solo
 * resuelve turnos de ESTA clienta.
 */
export function verifyOffersRescheduleSlots(result: EvalResult, timeZone: string): string | null {
  const reserve: OfferedSlot[] = [];
  const reschedule: OfferedSlot[] = [];
  for (const option of result.opciones) {
    const choice = parseChoiceId(option.id);
    if (choice?.kind !== 'slot' && choice?.kind !== 'reschedule') continue;
    const slot: OfferedSlot = {
      start: choice.start,
      professional: null,
      local: instantToLocal(choice.start, timeZone),
      stillFree: option.resuelta?.tipo === 'reprogramar',
    };
    (choice.kind === 'slot' ? reserve : reschedule).push(slot);
  }

  const wrong = reserve[0];
  if (wrong) return `Ofreció un horario para reservar (horario:) en vez de uno para reprogramar: ${label(wrong)} (hora local)`;
  if (reschedule.length === 0) return 'No ofreció ningún horario';
  const unresolved = reschedule.find((slot) => !slot.stillFree);
  return unresolved
    ? `El horario para reprogramar ${label(unresolved)} (hora local) no es de un turno de la clienta`
    : null;
}

/**
 * Ofreció el botón «Sí, cancelar» (4.6) de un turno de la clienta que sigue activo: el id se
 * volvió a resolver contra la base, que solo resuelve turnos de ESTA clienta.
 */
export function verifyCancelButtonOffered(result: EvalResult): string | null {
  const button = result.opciones.find((option) => parseChoiceId(option.id)?.kind === 'cancel');
  if (!button) return 'No ofreció el botón «Sí, cancelar»';
  if (button.resuelta?.tipo !== 'cancelar') return 'El botón de cancelar no es de un turno de la clienta';
  return button.resuelta.ocupaHorario ? null : 'El botón de cancelar es de un turno que ya no está activo';
}

/**
 * Los horarios ofrecidos van como botones o lista: el texto no los repite (6.4, reglas del prompt).
 * Nombrar uno solo está bien («el primero libre es a las 13:00»); repetir dos o más, no. La prueba
 * manual con Meta mostró la lista entera escrita en el texto y además como botones.
 */
export function verifySlotsNotRepeatedInText(result: EvalResult, timeZone: string): string | null {
  // "09:00" se escribe "9:00" en el texto: se compara sin el cero de adelante.
  const repeated = offeredSlots(result, timeZone)
    .map((slot) => slot.local.time.replace(/^0/, ''))
    .filter((time) => new RegExp(String.raw`(?<![\d:])${time}(?!\d)`).test(result.texto));
  return repeated.length >= 2
    ? `Repitió en el texto los horarios que ya ofrece como opciones: ${repeated.join(', ')}`
    : null;
}
