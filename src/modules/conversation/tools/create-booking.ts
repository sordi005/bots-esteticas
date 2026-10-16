import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { customers } from '../../customers/schema.js';
import { bookAppointment, type BookingRefusal } from '../../scheduling/booking.js';
import {
  findCustomerAppointment,
  findCustomerAppointmentAt,
  type CustomerAppointment,
} from '../../scheduling/customer-appointments.js';
import {
  loadAppointmentSettings,
  summarizeAppointment,
  type AppointmentSettings,
} from './appointment-summary.js';
import { parseChoiceId } from './choice-ids.js';
import { depositPayment, derivedPaymentMessage, PAYMENT_INSTRUCTIONS } from './deposit-payment.js';
import { NEEDS_CHOICE_MESSAGE, offerForConfirmation, wasChosenByCustomer } from './slot-offer.js';
import type { AgentTool, ToolContext, ToolResult } from './tool.js';

/** Largo del nombre para el turno [S]. */
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 80;

const input = z.object({
  horario_id: z
    .string()
    .describe(
      'Id del horario a reservar, TAL CUAL lo devolvió consultar_disponibilidad (opcionId) o lo indica ' +
        'el contexto de la vuelta (horario_id=…). Nunca lo armes ni lo cambies.',
    ),
  nombre: z
    .string()
    .trim()
    .min(MIN_NAME_LENGTH)
    .max(MAX_NAME_LENGTH)
    .optional()
    .describe(
      'Nombre de la clienta para anotar el turno (2 a 80 caracteres). Obligatorio si el contexto dice que ' +
        'no hay un nombre cargado: preguntaselo antes de reservar.',
    ),
});

type Input = z.infer<typeof input>;

const refusal = (motivo: string, mensaje: string, isError: boolean): ToolResult => ({
  content: { reservado: false, motivo, mensaje },
  options: [],
  isError,
});

/** Cómo se le cuenta al modelo cada rechazo de `bookAppointment`: algo accionable, escrito por el código. */
function describeRefusal(reason: BookingRefusal): ToolResult {
  switch (reason) {
    case 'slot_taken':
      return refusal(
        'horario_ocupado',
        'Ese horario se acaba de ocupar. Avisale a la clienta, volvé a consultar la disponibilidad con ' +
          'consultar_disponibilidad y ofrecele otros horarios.',
        false,
      );
    case 'slot_unavailable':
      return refusal(
        'horario_no_valido',
        'Ese no es un horario válido para reservar (fuera del horario de atención, de la grilla o sin la ' +
          'anticipación necesaria). Consultá la disponibilidad y ofrecé uno de los horarios que devuelve.',
        true,
      );
    case 'service_not_bookable':
      return refusal(
        'servicio_no_reservable',
        'Este servicio no se reserva por este medio (requiere consulta previa o no se ofrece). No reservaste ' +
          'nada: ofrecele que lo vea una persona y, si acepta, derivá con el motivo consulta_previa en el campo «derivar» de tu respuesta.',
        false,
      );
    case 'professional_unavailable':
      return refusal(
        'profesional_no_hace_el_servicio',
        'Esa profesional no hace este servicio. Consultá la disponibilidad con consultar_disponibilidad.',
        true,
      );
    case 'not_found':
      return refusal(
        'no_encontrado',
        'No encontré ese servicio o ese horario. Consultá la disponibilidad con consultar_disponibilidad.',
        true,
      );
  }
}

/**
 * El turno quedó reservado. Con la seña pendiente lleva los datos para pagarla (4.5): salen en la
 * misma respuesta que la reserva. Si no hay cómo cobrarla por acá, deriva sola.
 */
async function reservedResult(
  appointment: CustomerAppointment,
  ctx: ToolContext,
  settings: AppointmentSettings,
  alreadyBooked: boolean,
): Promise<ToolResult> {
  const summary = summarizeAppointment(appointment, { now: ctx.now, timeZone: ctx.timeZone, settings });
  const deadline = (summary.sena as { pagarHasta?: string } | undefined)?.pagarHasta;
  const state =
    appointment.status === 'PENDING_DEPOSIT'
      ? `Quedó reservado, pendiente de seña${deadline ? `: si no se paga ${deadline}, se libera el horario` : ''}.`
      : 'Quedó confirmado.';
  const intro = alreadyBooked ? `Esa reserva ya estaba hecha. ${state}` : state;
  const base = { reservado: true, ...(alreadyBooked ? { yaEstabaReservado: true } : {}), ...summary };

  const payment = appointment.status === 'PENDING_DEPOSIT' && deadline ? await depositPayment(ctx, appointment) : null;
  if (payment?.kind === 'transfer') {
    return {
      content: { ...base, pago: payment.content, mensaje: `${intro} ${PAYMENT_INSTRUCTIONS}` },
      options: [],
      changedAppointment: true,
      mustMention: payment.mustMention,
    };
  }
  if (payment?.kind === 'derived') {
    return {
      content: { ...base, derivada: true, cuando: payment.when, mensaje: `${intro} ${derivedPaymentMessage(payment.when)}` },
      options: [],
      changedAppointment: true,
    };
  }
  return { content: { ...base, mensaje: intro }, options: [], changedAppointment: true };
}

/**
 * El modelo pidió reservar un horario que la clienta no eligió con un botón: no se reserva nada y se
 * le devuelve ese horario como opción, para que ella lo confirme tocándola (6.4).
 */
async function askToConfirm(
  ctx: ToolContext,
  slot: { serviceId: string; professionalId: string; start: Date },
): Promise<ToolResult> {
  const found = await offerForConfirmation(ctx, slot);
  // El servicio o la profesional no son de este negocio: no hay nada para ofrecer.
  if (!found) return describeRefusal('not_found');
  // Un horario que ya no está libre no se ofrece como botón: se vuelve a consultar la disponibilidad.
  if (!found.free) {
    return refusal(
      'horario_no_disponible',
      'Ese horario ya no está libre o no se puede reservar por este medio. No reservaste nada: volvé a consultar ' +
        'la disponibilidad con consultar_disponibilidad y ofrecele otros horarios.',
      false,
    );
  }
  return {
    content: { reservado: false, motivo: 'falta_que_elija', mensaje: NEEDS_CHOICE_MESSAGE, horario: found.offer.content },
    options: [found.offer.option],
  };
}

/**
 * `crear_reserva(horario_id, nombre?)` (6.4, 6.6): reserva el horario que eligió la clienta.
 * El horario es el id que devolvió `consultar_disponibilidad`: ya trae el servicio, la profesional
 * y el inicio, y `bookAppointment` lo vuelve a validar todo contra la base (la seña la calcula ahí).
 * Solo reserva un horario que la clienta eligió con un botón o una lista (en esta vuelta o en las
 * últimas 24 horas): si no, lo ofrece para que lo confirme. Es idempotente: si la clienta ya tiene
 * ese mismo turno, lo devuelve como reservado, sin pedir la elección otra vez.
 */
export const createBookingTool: AgentTool<Input> = {
  name: 'crear_reserva',
  description:
    'Reserva un horario para la clienta. Pasale el horario_id que devolvió consultar_disponibilidad (o el que ' +
    'indica el contexto cuando ella eligió un horario con un botón) y, si el contexto dice que no hay un nombre ' +
    'cargado, el nombre. Devuelve el estado del turno (confirmado o pendiente de seña) y, si lleva seña, el monto, ' +
    'hasta cuándo pagarla y los datos para pagarla («pago»), ya escritos: pasáselos tal cual en la misma respuesta. Solo decí que quedó reservado si devuelve ' +
    'reservado=true. Solo reserva un horario que la clienta eligió con un botón o una lista: si todavía no lo ' +
    'eligió, no reserva nada y devuelve motivo=falta_que_elija con ese horario para que se lo ofrezcas como ' +
    'opción. Si el horario se ocupó, volvé a consultar la disponibilidad y ofrecé otros. Pedirlo dos veces ' +
    'no duplica la reserva. Es solo para turnos nuevos: un horario_id que empieza con "reprogramar:" es para mover un ' +
    'turno que la clienta ya tiene y va a reprogramar_turno, no acá.',
  input,
  async run({ horario_id, nombre }, ctx) {
    ctx.signal.throwIfAborted();
    const { db, tenantId, customerId, now } = ctx;

    const choice = parseChoiceId(horario_id);
    // La intención va en el id (decisión 28): un horario para mover un turno nunca reserva uno nuevo.
    if (choice?.kind === 'reschedule') {
      return refusal(
        'horario_para_reprogramar',
        'Ese horario es para reprogramar su turno: usá reprogramar_turno con ese mismo horario_id. No reservaste nada.',
        true,
      );
    }
    if (choice?.kind !== 'slot') {
      return refusal(
        'id_de_horario_invalido',
        'Ese no es el id de un horario: usá el opcionId que devolvió consultar_disponibilidad (o el horario_id ' +
          'del contexto), sin cambiarlo.',
        true,
      );
    }
    const { serviceId, professionalId, start } = choice;
    const settings = await loadAppointmentSettings(db, tenantId);

    const saveName = async () => {
      if (!nombre) return;
      await db
        .update(customers)
        .set({ name: nombre })
        .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
    };
    const findExisting = () =>
      findCustomerAppointmentAt(db, { tenantId, customerId, serviceId, professionalId, start, now });

    // Un reintento (o dos llamadas a la vez) del mismo turno: se devuelve el que ya está.
    const existing = await findExisting();
    if (existing) {
      await saveName();
      return reservedResult(existing, ctx, settings, true);
    }

    // Elegir es la confirmación (principio 5). Va antes del nombre: primero se confirma el horario.
    if (!wasChosenByCustomer(ctx, horario_id)) return askToConfirm(ctx, { serviceId, professionalId, start });

    const [customer] = await db
      .select({ name: customers.name })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
    if (!customer) throw new Error('No se encontró la clienta de la conversación');
    if (!customer.name && !nombre) {
      return refusal(
        'falta_nombre',
        'Todavía no hay un nombre cargado para anotar el turno: pedile el nombre a la clienta y volvé a llamar a ' +
          'crear_reserva con el mismo horario_id y el nombre. No reservaste nada.',
        true,
      );
    }

    const booked = await bookAppointment(db, {
      tenantId,
      customerId,
      serviceId,
      professionalId,
      start,
      actor: 'assistant',
      now,
    });

    if (!booked.ok) {
      // Si dos llamadas pedían lo mismo a la vez, la que perdió el horario se lo encuentra ganado por la otra.
      if (booked.reason === 'slot_taken') {
        const winner = await findExisting();
        if (winner) {
          await saveName();
          return reservedResult(winner, ctx, settings, true);
        }
      }
      return describeRefusal(booked.reason);
    }

    await saveName();
    const appointment = await findCustomerAppointment(db, {
      tenantId,
      customerId,
      appointmentId: booked.appointmentId,
    });
    if (!appointment) throw new Error('No se encontró el turno recién creado');
    return reservedResult(appointment, ctx, settings, false);
  },
};
