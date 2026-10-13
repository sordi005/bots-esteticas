import { formatLocalSlot, formatShortSlot, truncateText } from '../format.js';
import { choiceIds } from './choice-ids.js';
import { resolveChoice } from './choices.js';
import { MAX_OPTION_DESCRIPTION_LENGTH, type OfferableOption, type ToolContext } from './tool.js';

/**
 * Un horario que se le ofrece a la clienta: lo que lee el modelo (con el `opcionId`, que es lo que
 * tiene que poner en «opciones») y la opción para el botón o la fila de lista. Lo comparten
 * `consultar_disponibilidad` y las herramientas que piden que la clienta confirme un horario.
 */

export interface SlotOffer {
  content: {
    opcionId: string;
    texto: string;
    profesional: string;
    profesionalId: string;
    /** Inicio en UTC, ISO 8601. */
    inicio: string;
    duracionMinutos: number;
  };
  option: OfferableOption;
}

export function slotOffer(
  input: {
    serviceId: string;
    professionalId: string;
    professionalName: string;
    start: Date;
    durationMinutes: number;
    /**
     * Si el horario es para mover este turno: el id es `reprogramar:<turno>:<inicio>` y no
     * `horario:...`, así lo que toca la clienta ya dice qué quiere hacer (decisión 28).
     */
    rescheduleAppointmentId?: string;
  },
  timeZone: string,
): SlotOffer {
  const id = input.rescheduleAppointmentId
    ? choiceIds.reschedule(input.rescheduleAppointmentId, input.start)
    : choiceIds.slot(input.serviceId, input.professionalId, input.start);
  return {
    content: {
      opcionId: id,
      texto: formatLocalSlot(input.start, timeZone),
      profesional: input.professionalName,
      profesionalId: input.professionalId,
      inicio: input.start.toISOString(),
      duracionMinutos: input.durationMinutes,
    },
    option: {
      id,
      title: formatShortSlot(input.start, timeZone),
      description: truncateText(`con ${input.professionalName}`, MAX_OPTION_DESCRIPTION_LENGTH),
    },
  };
}

/**
 * ¿La clienta eligió este horario con un botón o una lista (en esta vuelta o en las últimas 24
 * horas)? Reservar y reprogramar solo actúan sobre un horario elegido: elegir es la confirmación
 * (principio 5, 6.4). El conjunto lo arma el servidor; el modelo no puede agregarle nada.
 */
export function wasChosenByCustomer(ctx: Pick<ToolContext, 'chosenOptionIds'>, slotId: string): boolean {
  return ctx.chosenOptionIds.has(slotId);
}

/**
 * El horario que el modelo pidió sin que la clienta lo eligiera, listo para ofrecérselo. Null si el
 * servicio o la profesional no existen en este negocio. `free` dice si el horario sigue libre.
 */
export async function offerForConfirmation(
  ctx: ToolContext,
  slot: { serviceId: string; professionalId: string; start: Date },
): Promise<{ offer: SlotOffer; free: boolean } | null> {
  const resolved = await resolveChoice(ctx.db, ctx, choiceIds.slot(slot.serviceId, slot.professionalId, slot.start));
  if (resolved.tipo !== 'horario') return null;
  return {
    offer: slotOffer(
      {
        serviceId: resolved.servicioId,
        professionalId: resolved.profesionalId,
        professionalName: resolved.profesionalNombre,
        start: new Date(resolved.inicio),
        durationMinutes: resolved.duracionMinutos,
      },
      ctx.timeZone,
    ),
    free: resolved.sigueLibre,
  };
}

/**
 * Lo mismo para un horario de REPROGRAMAR que el modelo pidió sin que la clienta lo eligiera: el
 * horario nuevo de ese turno, con id `reprogramar:` y su duración. Null si el turno no es de la clienta.
 * `free` dice si sigue libre (contando al propio turno como libre) y el turno ocupa horario.
 */
export async function offerRescheduleForConfirmation(
  ctx: ToolContext,
  slot: { appointmentId: string; start: Date },
): Promise<{ offer: SlotOffer; free: boolean } | null> {
  const resolved = await resolveChoice(ctx.db, ctx, choiceIds.reschedule(slot.appointmentId, slot.start));
  if (resolved.tipo !== 'reprogramar') return null;
  return {
    offer: slotOffer(
      {
        serviceId: resolved.servicioId,
        professionalId: resolved.profesionalId,
        professionalName: resolved.profesionalNombre,
        start: new Date(resolved.inicio),
        durationMinutes: resolved.duracionMinutos,
        rescheduleAppointmentId: resolved.turnoId,
      },
      ctx.timeZone,
    ),
    free: resolved.sigueLibre,
  };
}

/** Lo que se le dice al modelo cuando pidió actuar sobre un horario que la clienta no eligió. */
export const NEEDS_CHOICE_MESSAGE =
  'No se hizo nada: la clienta todavía no eligió este horario: ofrecéselo como opción para que lo confirme ' +
  '(poné en «opciones» el opcionId de «horario» y escribí una frase corta). Cuando lo elija, el contexto de ' +
  'la vuelta te lo dice y ahí sí volvé a llamar a esta herramienta.';
