/**
 * Ids de las opciones que las herramientas le ofrecen a la clienta (botones y listas, 5.3):
 *
 *   servicio:<servicio>
 *   horario:<servicio>:<profesional>:<inicio ISO en UTC>
 *   mas:<servicio>:<profesional o "-">:<inicio ISO del último horario ofrecido>
 *   turno:<turno>       un turno de la clienta, para elegir cuál cancelar o reprogramar
 *   cancelar:<turno>    el botón "Sí, cancelar" (4.6)
 *   reprogramar:<turno>:<inicio ISO en UTC>
 *                       un horario nuevo para mover un turno. La intención va en el id (decisión 28):
 *                       `horario:` solo reserva y `reprogramar:` solo reprograma.
 *   mas_reprogramar:<turno>:<inicio ISO del último horario ofrecido>
 *                       "Ver otros horarios" de una reprogramación: sigue en modo reprogramar.
 *   recordatorio:<turno>:confirmar|reprogramar|cancelar
 *                       los botones del recordatorio del día anterior (4.7, H10): van en una plantilla y
 *                       vuelven como el dato del botón.
 *
 * Cuando la clienta elige, WhatsApp devuelve el id tal cual. Nunca se confía en él: se lee
 * con `parseChoiceId` y se vuelve a validar contra la base (`resolveChoice`).
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const INSTANT = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';

const SERVICE_ID = new RegExp(`^servicio:(${UUID})$`);
const SLOT_ID = new RegExp(`^horario:(${UUID}):(${UUID}):(${INSTANT})$`);
const MORE_ID = new RegExp(`^mas:(${UUID}):(${UUID}|-):(${INSTANT})$`);
const APPOINTMENT_ID = new RegExp(`^turno:(${UUID})$`);
const CANCEL_ID = new RegExp(`^cancelar:(${UUID})$`);
const RESCHEDULE_ID = new RegExp(`^reprogramar:(${UUID}):(${INSTANT})$`);
const MORE_RESCHEDULE_ID = new RegExp(`^mas_reprogramar:(${UUID}):(${INSTANT})$`);
const REMINDER_ID = new RegExp(`^recordatorio:(${UUID}):(confirmar|reprogramar|cancelar)$`);
const BARE_UUID = new RegExp(`^${UUID}$`);

/** Lo que pide la clienta desde el recordatorio: confirmar que va, reprogramar o cancelar (4.7). */
export type ReminderAction = 'confirm' | 'reschedule' | 'cancel';

const REMINDER_CODES = {
  confirm: 'confirmar',
  reschedule: 'reprogramar',
  cancel: 'cancelar',
} as const satisfies Record<ReminderAction, string>;

const REMINDER_ACTIONS = new Map<string, ReminderAction>(
  Object.entries(REMINDER_CODES).map(([action, code]) => [code, action as ReminderAction]),
);

export const choiceIds = {
  service: (serviceId: string) => `servicio:${serviceId}`,
  slot: (serviceId: string, professionalId: string, start: Date) =>
    `horario:${serviceId}:${professionalId}:${start.toISOString()}`,
  more: (serviceId: string, professionalId: string | null, after: Date) =>
    `mas:${serviceId}:${professionalId ?? '-'}:${after.toISOString()}`,
  appointment: (appointmentId: string) => `turno:${appointmentId}`,
  cancel: (appointmentId: string) => `cancelar:${appointmentId}`,
  reschedule: (appointmentId: string, start: Date) => `reprogramar:${appointmentId}:${start.toISOString()}`,
  moreReschedule: (appointmentId: string, after: Date) => `mas_reprogramar:${appointmentId}:${after.toISOString()}`,
  reminder: (appointmentId: string, action: ReminderAction) => `recordatorio:${appointmentId}:${REMINDER_CODES[action]}`,
};

export type ParsedChoiceId =
  | { kind: 'service'; serviceId: string }
  | { kind: 'slot'; serviceId: string; professionalId: string; start: Date }
  | { kind: 'more'; serviceId: string; professionalId: string | null; after: Date }
  | { kind: 'appointment'; appointmentId: string }
  | { kind: 'cancel'; appointmentId: string }
  | { kind: 'reschedule'; appointmentId: string; start: Date }
  | { kind: 'more_reschedule'; appointmentId: string; after: Date }
  | { kind: 'reminder'; appointmentId: string; action: ReminderAction };

/** Una fecha con la forma exacta de `toISOString()`, o null si no existe en el calendario. */
function parseInstant(text: string): Date | null {
  const instant = new Date(text);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === text ? instant : null;
}

export function parseChoiceId(id: string): ParsedChoiceId | null {
  const service = SERVICE_ID.exec(id);
  if (service?.[1]) return { kind: 'service', serviceId: service[1] };

  const slot = SLOT_ID.exec(id);
  if (slot?.[1] && slot[2] && slot[3]) {
    const start = parseInstant(slot[3]);
    return start ? { kind: 'slot', serviceId: slot[1], professionalId: slot[2], start } : null;
  }

  const more = MORE_ID.exec(id);
  if (more?.[1] && more[2] && more[3]) {
    const after = parseInstant(more[3]);
    return after
      ? { kind: 'more', serviceId: more[1], professionalId: more[2] === '-' ? null : more[2], after }
      : null;
  }

  const appointment = APPOINTMENT_ID.exec(id);
  if (appointment?.[1]) return { kind: 'appointment', appointmentId: appointment[1] };

  const cancel = CANCEL_ID.exec(id);
  if (cancel?.[1]) return { kind: 'cancel', appointmentId: cancel[1] };

  const reschedule = RESCHEDULE_ID.exec(id);
  if (reschedule?.[1] && reschedule[2]) {
    const start = parseInstant(reschedule[2]);
    return start ? { kind: 'reschedule', appointmentId: reschedule[1], start } : null;
  }

  const moreReschedule = MORE_RESCHEDULE_ID.exec(id);
  if (moreReschedule?.[1] && moreReschedule[2]) {
    const after = parseInstant(moreReschedule[2]);
    return after ? { kind: 'more_reschedule', appointmentId: moreReschedule[1], after } : null;
  }

  const reminder = REMINDER_ID.exec(id);
  const action = reminder?.[2] ? REMINDER_ACTIONS.get(reminder[2]) : undefined;
  if (reminder?.[1] && action) return { kind: 'reminder', appointmentId: reminder[1], action };

  return null;
}

/**
 * El turno que nombra el modelo en `cancelar_turno` o `reprogramar_turno`: el id que le dio
 * `listar_turnos_de_la_clienta` (`turno:<uuid>`) o el uuid solo. Null si es otra cosa.
 */
export function parseAppointmentRef(ref: string): string | null {
  const choice = APPOINTMENT_ID.exec(ref);
  if (choice?.[1]) return choice[1];
  return BARE_UUID.test(ref) ? ref : null;
}
