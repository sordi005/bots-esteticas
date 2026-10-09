import type { AppointmentStatus } from '../../src/modules/scheduling/appointment-state-machine.js';
import { normalizeText, type EvalAppointmentState, type EvalResult, type EvalState } from './evaluate.js';

/**
 * Chequeos con código sobre lo que quedó en la base después de la vuelta (`EvalResult.estado`),
 * para el `verifica` de los casos. Cada uno devuelve el motivo del fallo, o null si está bien.
 * Leen la base y no lo que dice el texto de la respuesta: nunca se confía en que el agente
 * "diga" que reservó o canceló.
 */

type Handoff = EvalState['derivaciones'][number];

const describeAppointment = (appointment: Pick<EvalAppointmentState, 'servicio' | 'profesional' | 'inicio' | 'estado'>) =>
  `${appointment.servicio} con ${appointment.profesional} el ${appointment.inicio} (${appointment.estado})`;

const describeList = (appointments: Parameters<typeof describeAppointment>[0][]) =>
  appointments.length > 0 ? appointments.map(describeAppointment).join('; ') : 'ninguno';

export interface ExpectedAppointment {
  servicio: string;
  profesional: string;
  /** Inicio en hora local del negocio, "AAAA-MM-DD HH:MM". */
  inicio: string;
  estado: AppointmentStatus;
}

/** Juntar chequeos: null si todos pasan; si no, los motivos de los que fallan (sin repetir el mismo). */
export function combineChecks(...checks: (string | null)[]): string | null {
  const failures = [...new Set(checks.filter((check): check is string => check !== null))];
  return failures.length > 0 ? failures.join(' | ') : null;
}

/**
 * Los turnos de la clienta del caso (`de: 'clienta'`) o de otra clienta que preparó el caso
 * (`de: 'otra'`) son EXACTAMENTE estos, sin importar el orden. Sin esperados: no tiene ninguno.
 */
export function verifyAppointmentsOf(
  result: EvalResult,
  owner: EvalAppointmentState['de'],
  expected: ExpectedAppointment[],
): string | null {
  const actual = result.estado.turnos.filter((appointment) => appointment.de === owner);
  const sorted = (list: ExpectedAppointment[]) => list.map(describeAppointment).sort();

  const same = JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
  if (same) return null;
  const whose = owner === 'clienta' ? 'la clienta' : 'otra clienta';
  return `Los turnos de ${whose} no son los esperados. Esperados: ${describeList(expected)}. Quedaron: ${describeList(actual)}`;
}

/** Un turno que preparó el caso (por su `clave`): solo se mira lo que se pide (el inicio y/o el estado). */
export function verifyAppointment(
  result: EvalResult,
  clave: string,
  expected: { inicio?: string; estado?: AppointmentStatus },
): string | null {
  const found = result.estado.turnos.find((appointment) => appointment.clave === clave);
  if (!found) return `No está el turno «${clave}» entre los que preparó el caso`;

  const failures: string[] = [];
  if (expected.estado !== undefined && found.estado !== expected.estado) {
    failures.push(`El turno «${clave}» quedó ${found.estado} y se esperaba ${expected.estado}`);
  }
  if (expected.inicio !== undefined && found.inicio !== expected.inicio) {
    failures.push(`El turno «${clave}» quedó el ${found.inicio} y se esperaba el ${expected.inicio}`);
  }
  return combineChecks(...failures);
}

/** Derivó UNA vez, con ese motivo, y la conversación quedó pausada. */
export function verifyHandoff(result: EvalResult, reason: Handoff['motivo']): string | null {
  const { derivaciones, pausada } = result.estado;
  if (derivaciones.length === 0) return `No derivó a una persona (se esperaba el motivo ${reason})`;
  if (derivaciones.length > 1) {
    return `Se esperaba una sola derivación y hubo ${String(derivaciones.length)} (${derivaciones.map((handoff) => handoff.motivo).join(', ')})`;
  }
  const [handoff] = derivaciones;
  if (handoff?.motivo !== reason) return `Derivó por ${handoff?.motivo ?? 'ninguno'} y se esperaba ${reason}`;
  if (!pausada) return 'Derivó pero la conversación no quedó pausada';
  return null;
}

/** No derivó ni pausó la conversación. */
export function verifyNotHandedOff(result: EvalResult): string | null {
  const { derivaciones, pausada } = result.estado;
  if (derivaciones.length > 0) {
    return `No debía derivar y derivó por ${derivaciones.map((handoff) => handoff.motivo).join(', ')}`;
  }
  return pausada ? 'No debía pausar la conversación' : null;
}

/** Hay una derivación y ningún resumen guardado contiene `text` (regla 9: sin datos de salud). */
export function verifyHandoffSummaryWithout(result: EvalResult, text: string): string | null {
  const { derivaciones } = result.estado;
  if (derivaciones.length === 0) return 'No hay ninguna derivación para mirar el resumen';
  const found = derivaciones.find((handoff) => normalizeText(handoff.resumen).includes(normalizeText(text)));
  return found ? `El resumen de la derivación contiene "${text}": «${found.resumen}»` : null;
}

/** El nombre que quedó en la ficha de la clienta. */
export function verifyCustomerName(result: EvalResult, expected: string): string | null {
  const { nombreClienta } = result.estado;
  if (nombreClienta === expected) return null;
  return `El nombre guardado es ${nombreClienta === null ? 'ninguno' : `«${nombreClienta}»`} y se esperaba «${expected}»`;
}
