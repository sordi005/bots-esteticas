import { z } from 'zod';
import { holdsSchedule } from '../../scheduling/availability.js';
import { countReschedules, rescheduleAppointment } from '../../scheduling/booking.js';
import { evaluateCustomerReschedule } from '../../scheduling/change-policy.js';
import { findCustomerAppointment, type CustomerAppointment } from '../../scheduling/customer-appointments.js';
import {
  displayStatus,
  loadAppointmentSettings,
  summarizeAppointment,
} from './appointment-summary.js';
import { parseChoiceId } from './choice-ids.js';
import { deriveForPolicy } from './policy-handoff.js';
import { NEEDS_CHOICE_MESSAGE, offerRescheduleForConfirmation, wasChosenByCustomer } from './slot-offer.js';
import type { AgentTool, ToolContext, ToolResult } from './tool.js';

/** El motivo que queda en el evento de auditoría del turno. */
const RESCHEDULE_REASON = 'La clienta pidió reprogramar por WhatsApp';

const input = z.object({
  horario_id: z
    .string()
    .describe(
      'Id del horario nuevo, TAL CUAL lo devolvió consultar_horarios_para_reprogramar (opcionId, empieza con ' +
        '"reprogramar:") o lo indica el contexto (horario_id=…). Ya lleva el turno que se mueve. Nunca lo armes ni lo cambies.',
    ),
});

type Input = z.infer<typeof input>;

const failure = (motivo: string, mensaje: string): ToolResult => ({
  content: { reprogramado: false, motivo, mensaje },
  options: [],
  isError: true,
});

/** Un horario nuevo que se ocupó o no es válido: el turno queda donde estaba. */
function slotRefusal(reason: 'slot_taken' | 'slot_unavailable'): ToolResult {
  if (reason === 'slot_taken') {
    return {
      content: {
        reprogramado: false,
        motivo: 'horario_ocupado',
        mensaje:
          'Ese horario se acaba de ocupar. El turno sigue donde estaba. Avisale a la clienta, volvé a consultar ' +
          'los horarios con consultar_horarios_para_reprogramar y ofrecele otros.',
      },
      options: [],
    };
  }
  return failure(
    'horario_no_valido',
    'Ese no es un horario válido (fuera del horario de atención, de la grilla o sin la anticipación necesaria). ' +
      'El turno sigue donde estaba. Consultá los horarios con consultar_horarios_para_reprogramar y ofrecé uno de los que devuelve.',
  );
}

function rescheduledResult(
  appointment: CustomerAppointment,
  ctx: ToolContext,
  summaryContext: Parameters<typeof summarizeAppointment>[1],
  options: { alreadyThere: boolean; keptDeposit: boolean },
): ToolResult {
  return {
    content: {
      reprogramado: true,
      ...(options.alreadyThere ? { yaEstaba: true } : {}),
      turno: summarizeAppointment(appointment, summaryContext),
      ...(options.keptDeposit ? { senaConservada: true } : {}),
      mensaje: options.alreadyThere
        ? 'El turno ya estaba en ese horario.'
        : options.keptDeposit
          ? 'El turno quedó reprogramado y la seña sigue valiendo.'
          : 'El turno quedó reprogramado.',
    },
    options: [],
  };
}

/**
 * `reprogramar_turno(horario_id)` (6.4, 4.6, decisión 28): mueve un turno de la clienta que escribe a
 * otro horario del mismo servicio con la misma profesional. El id `reprogramar:<turno>:<inicio>` ya
 * trae el turno: solo acepta esos ids, nunca uno de reservar. Elegir el horario nuevo ya es la
 * confirmación. Si no corresponde (fuera de plazo, ya empezó, sin reprogramaciones que conserven
 * la seña), no toca el turno y deriva sola. Es idempotente: si el turno ya está en ese horario, lo dice.
 */
export const rescheduleAppointmentTool: AgentTool<Input> = {
  name: 'reprogramar_turno',
  description:
    'Reprograma un turno de la clienta a otro horario del MISMO servicio con la MISMA profesional. Pasale el ' +
    'horario_id que devolvió consultar_horarios_para_reprogramar (empieza con "reprogramar:") o que indica el contexto cuando ella eligió ese horario con un botón: ya trae el turno, no hace ' +
    'falta otro dato. No sirve un horario_id de reservar (empieza con "horario:"). Solo mueve el turno a un horario ' +
    'que la clienta eligió con un botón o una lista: si todavía no lo eligió, no cambia nada y devuelve ' +
    'motivo=falta_que_elija con ese horario para que se lo ofrezcas como opción. Cuando ella lo elige ya está ' +
    'confirmado: no hace falta pedirle otra confirmación. Si no corresponde (faltan menos horas que el plazo, el ' +
    'turno ya empezó o ya usó las reprogramaciones que conservan la seña), la herramienta no cambia nada, deriva ' +
    'sola a una persona y devuelve la política y cuándo le responde una persona: explicalo con amabilidad, sin ' +
    'discutir ni prometer excepciones. Cambiar de servicio o de profesional no se hace acá. Solo reprograma turnos ' +
    'de la clienta que escribe.',
  input,
  async run({ horario_id }, ctx) {
    ctx.signal.throwIfAborted();
    const { db, tenantId, customerId, now, timeZone } = ctx;

    const slot = parseChoiceId(horario_id);
    // La intención va en el id: un horario para reservar nunca mueve un turno (decisión 28).
    if (slot?.kind === 'slot') {
      return failure(
        'horario_para_reservar',
        'Ese horario es para reservar un turno nuevo, no para mover uno que la clienta ya tiene: no mueve nada. ' +
          'Para reprogramar, consultá los horarios con consultar_horarios_para_reprogramar pasando el turno_id del ' +
          'turno y usá el opcionId de los horarios que devuelve.',
      );
    }
    if (slot?.kind !== 'reschedule') {
      return failure(
        'id_de_horario_invalido',
        'Ese no es el id de un horario para reprogramar: usá el opcionId que devolvió ' +
          'consultar_horarios_para_reprogramar (empieza con "reprogramar:") o el horario_id del contexto, sin cambiarlo.',
      );
    }

    // El turno sale del id, pero nunca se confía en él: tiene que ser de ESTA clienta (regla 2).
    const appointment = await findCustomerAppointment(db, { tenantId, customerId, appointmentId: slot.appointmentId });
    if (!appointment) {
      return failure(
        'turno_no_encontrado',
        'No encontré ese turno entre los de la clienta. Mirá sus turnos con listar_turnos_de_la_clienta.',
      );
    }
    if (!holdsSchedule({ status: appointment.status, depositExpiresAt: appointment.deposit?.expiresAt ?? null }, now)) {
      return failure(
        'turno_no_activo',
        `Ese turno ya no está activo (${displayStatus(appointment, now)}), así que no se puede reprogramar.`,
      );
    }

    const settings = await loadAppointmentSettings(db, tenantId);
    const summaryContext = { now, timeZone, settings };
    const hasDeposit = appointment.deposit?.status === 'approved' || appointment.deposit?.status === 'in_review';

    // Un reintento: ya está en ese horario. Va antes de la política, que contaría la reprogramación ya hecha.
    if (appointment.start.getTime() === slot.start.getTime()) {
      return rescheduledResult(appointment, ctx, summaryContext, { alreadyThere: true, keptDeposit: false });
    }

    // Lo decide el código (4.6): si no corresponde, no se toca el turno y se deriva.
    const decision = evaluateCustomerReschedule({
      appointmentStart: appointment.start,
      now,
      freeCancellationNoticeHours: settings.freeCancellationNoticeHours,
      reschedulesUsed: await countReschedules(db, { tenantId, appointmentId: appointment.id }),
      reschedulesKeepingDeposit: settings.reschedulesKeepingDeposit,
      hasDeposit,
    });
    if (!decision.allowed) {
      return deriveForPolicy(ctx, { action: 'reschedule', refusal: decision.reason, appointment, settings });
    }

    // Elegir el horario nuevo es la confirmación (principio 5): si ella no lo eligió, se lo ofrecemos.
    if (!wasChosenByCustomer(ctx, horario_id)) {
      const found = await offerRescheduleForConfirmation(ctx, { appointmentId: appointment.id, start: slot.start });
      if (!found) {
        return failure(
          'no_encontrado',
          'No encontré ese turno o ese horario. Consultá los horarios con consultar_horarios_para_reprogramar y el turno_id.',
        );
      }
      // Un horario que ya no está libre no se ofrece como botón: se vuelve a consultar la disponibilidad.
      if (!found.free) {
        return {
          content: {
            reprogramado: false,
            motivo: 'horario_no_disponible',
            mensaje:
              'Ese horario ya no está libre o no es válido. No se movió nada: volvé a consultar los horarios ' +
              'con consultar_horarios_para_reprogramar y ofrecele otros.',
          },
          options: [],
        };
      }
      return {
        content: { reprogramado: false, motivo: 'falta_que_elija', mensaje: NEEDS_CHOICE_MESSAGE, horario: found.offer.content },
        options: [found.offer.option],
      };
    }

    const moved = await rescheduleAppointment(db, {
      tenantId,
      appointmentId: appointment.id,
      newStart: slot.start,
      actor: 'assistant',
      reason: RESCHEDULE_REASON,
      now,
    });
    if (!moved.ok) {
      switch (moved.reason) {
        case 'slot_taken':
        case 'slot_unavailable':
          return slotRefusal(moved.reason);
        case 'not_found':
        case 'not_reschedulable':
          return failure('turno_no_activo', 'Ese turno ya no se puede reprogramar.');
      }
    }

    const updated = await findCustomerAppointment(db, { tenantId, customerId, appointmentId: appointment.id });
    if (!updated) throw new Error('No se encontró el turno recién reprogramado');
    return rescheduledResult(updated, ctx, summaryContext, { alreadyThere: false, keptDeposit: hasDeposit });
  },
};
