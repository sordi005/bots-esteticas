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
          'nada: ofrecele que lo vea una persona y derivá con derivar_a_persona (motivo consulta_previa).',
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

function reservedResult(
  appointment: CustomerAppointment,
  ctx: ToolContext,
  settings: AppointmentSettings,
  alreadyBooked: boolean,
): ToolResult {
  const summary = summarizeAppointment(appointment, { now: ctx.now, timeZone: ctx.timeZone, settings });
  const deadline = (summary.sena as { pagarHasta?: string } | undefined)?.pagarHasta;
  const state =
    appointment.status === 'PENDING_DEPOSIT'
      ? `Quedó reservado, pendiente de seña${deadline ? `: si no se paga ${deadline}, se libera el horario` : ''}.`
      : 'Quedó confirmado.';
  return {
    content: {
      reservado: true,
      ...(alreadyBooked ? { yaEstabaReservado: true } : {}),
      ...summary,
      mensaje: alreadyBooked ? `Esa reserva ya estaba hecha. ${state}` : state,
    },
    options: [],
  };
}

/**
 * `crear_reserva(horario_id, nombre?)` (6.4, 6.6): reserva el horario que eligió la clienta.
 * El horario es el id que devolvió `consultar_disponibilidad`: ya trae el servicio, la profesional
 * y el inicio, y `bookAppointment` lo vuelve a validar todo contra la base (la seña la calcula ahí).
 * Es idempotente: si la clienta ya tiene ese mismo turno, lo devuelve como reservado.
 */
export const createBookingTool: AgentTool<Input> = {
  name: 'crear_reserva',
  description:
    'Reserva un horario para la clienta. Pasale el horario_id que devolvió consultar_disponibilidad (o el que ' +
    'indica el contexto cuando ella eligió un horario con un botón) y, si el contexto dice que no hay un nombre ' +
    'cargado, el nombre. Devuelve el estado del turno (confirmado o pendiente de seña) y, si lleva seña, el monto, ' +
    'hasta cuándo pagarla y el medio, ya escritos: decilos tal cual. Solo decí que quedó reservado si devuelve ' +
    'reservado=true. Si el horario se ocupó, volvé a consultar la disponibilidad y ofrecé otros. Pedirlo dos veces ' +
    'no duplica la reserva.',
  input,
  async run({ horario_id, nombre }, ctx) {
    ctx.signal.throwIfAborted();
    const { db, tenantId, customerId, now } = ctx;

    const choice = parseChoiceId(horario_id);
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
