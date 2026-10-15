import { z } from 'zod';
import { changeAppointmentStatus } from '../../scheduling/booking.js';
import { evaluateCustomerCancellation } from '../../scheduling/change-policy.js';
import { holdsSchedule } from '../../scheduling/availability.js';
import { findCustomerAppointment, type CustomerAppointment } from '../../scheduling/customer-appointments.js';
import {
  displayStatus,
  loadAppointmentSettings,
  summarizeAppointment,
  type AppointmentSettings,
} from './appointment-summary.js';
import { choiceIds, parseAppointmentRef } from './choice-ids.js';
import { deriveForPolicy } from './policy-handoff.js';
import type { AgentTool, ToolContext, ToolResult } from './tool.js';

/** El texto del botón de confirmación (4.6): entra en los 20 caracteres de un botón de WhatsApp. */
export const CANCEL_BUTTON_TITLE = 'Sí, cancelar';

/** El motivo que queda en el evento de auditoría del turno. */
const CANCEL_REASON = 'La clienta pidió cancelar por WhatsApp';

const input = z.object({
  turno_id: z
    .string()
    .describe('Id del turno, TAL CUAL lo devolvió listar_turnos_de_la_clienta (turnoId) o el contexto (turno_id=…).'),
  confirmada: z
    .boolean()
    .describe(
      'false para pedirle la confirmación a la clienta (no cancela nada); true SOLO después de que ella ' +
        'confirmó (tocó «Sí, cancelar» o dijo que sí con claridad).',
    ),
});

type Input = z.infer<typeof input>;

const failure = (motivo: string, mensaje: string): ToolResult => ({
  content: { cancelado: false, motivo, mensaje },
  options: [],
  isError: true,
});

/** El turno ya quedó cancelado (por esta llamada o por otra anterior). */
function cancelledResult(
  appointment: CustomerAppointment,
  ctx: ToolContext,
  settings: AppointmentSettings,
  alreadyCancelled: boolean,
): ToolResult {
  const paid = appointment.deposit?.status === 'approved' || appointment.deposit?.status === 'in_review';
  const summary = summarizeAppointment(appointment, { now: ctx.now, timeZone: ctx.timeZone, settings });
  return {
    content: {
      cancelado: true,
      ...(alreadyCancelled ? { yaEstabaCancelado: true } : {}),
      turno: summary,
      mensaje: alreadyCancelled ? 'Ese turno ya estaba cancelado.' : 'El turno quedó cancelado y el horario se liberó.',
      ...(paid && !alreadyCancelled
        ? {
            sena:
              'La seña ya estaba paga: no se devuelve ni se traspasa automáticamente y lo decide una persona ' +
              'del equipo. No prometas nada sobre la seña.',
          }
        : {}),
    },
    options: [],
    changedAppointment: true,
  };
}

/**
 * `cancelar_turno(turno_id, confirmada)` (6.4, 4.6): cancela un turno de la clienta que escribe.
 * Si no corresponde (fuera de plazo o ya empezó), no toca el turno y deriva sola. Si corresponde y
 * todavía no confirmó, ofrece el botón «Sí, cancelar»; con la confirmación, cancela.
 */
export const cancelAppointmentTool: AgentTool<Input> = {
  name: 'cancelar_turno',
  description:
    'Cancela un turno de la clienta. Primero llamala con confirmada=false: no cancela nada, devuelve el resumen ' +
    'del turno y el botón «Sí, cancelar» para ofrecérselo. Solo cuando la clienta confirmó (tocó el botón o dijo ' +
    'que sí con claridad) llamala con confirmada=true. Si cancelar no corresponde (faltan menos horas que el plazo ' +
    'o el turno ya empezó), la herramienta no cancela, deriva sola a una persona y devuelve la política y cuándo ' +
    'le responde una persona: explicalo con amabilidad, sin discutir ni prometer excepciones. Solo cancela ' +
    'turnos de la clienta que escribe.',
  input,
  async run({ turno_id, confirmada }, ctx) {
    ctx.signal.throwIfAborted();
    const { db, tenantId, customerId, now } = ctx;

    const appointmentId = parseAppointmentRef(turno_id);
    if (!appointmentId) {
      return failure(
        'id_de_turno_invalido',
        'Ese no es el id de un turno: usá el turnoId que devolvió listar_turnos_de_la_clienta, sin cambiarlo.',
      );
    }
    const appointment = await findCustomerAppointment(db, { tenantId, customerId, appointmentId });
    if (!appointment) {
      return failure(
        'turno_no_encontrado',
        'No encontré ese turno entre los de la clienta. Mirá sus turnos con listar_turnos_de_la_clienta.',
      );
    }

    const settings = await loadAppointmentSettings(db, tenantId);
    if (appointment.status === 'CANCELLED_BY_CUSTOMER') return cancelledResult(appointment, ctx, settings, true);

    if (!holdsSchedule({ status: appointment.status, depositExpiresAt: appointment.deposit?.expiresAt ?? null }, now)) {
      return failure(
        'turno_no_activo',
        `Ese turno ya no está activo (${displayStatus(appointment, now)}), así que no hay nada para cancelar.`,
      );
    }

    // Lo decide el código (4.6): si no corresponde, no se toca el turno y se deriva.
    const decision = evaluateCustomerCancellation({
      appointmentStart: appointment.start,
      now,
      freeCancellationNoticeHours: settings.freeCancellationNoticeHours,
    });
    if (!decision.allowed) {
      return deriveForPolicy(ctx, { action: 'cancel', refusal: decision.reason, appointment, settings });
    }

    if (!confirmada) {
      const button = { id: choiceIds.cancel(appointment.id), title: CANCEL_BUTTON_TITLE };
      return {
        content: {
          cancelado: false,
          faltaConfirmar: true,
          turno: summarizeAppointment(appointment, { now, timeZone: ctx.timeZone, settings }),
          // El modelo solo lee el contenido: sin este id ofrecería el del turno y el botón se descartaría.
          opcionId: button.id,
          mensaje:
            'Todavía no se canceló nada. Mostrale a la clienta el turno y preguntale si lo cancela; ofrecé el ' +
            `botón «${CANCEL_BUTTON_TITLE}»: poné en «opciones» el opcionId de esta respuesta (no el turnoId).`,
        },
        options: [button],
      };
    }

    const changed = await changeAppointmentStatus(db, {
      tenantId,
      appointmentId: appointment.id,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      reason: CANCEL_REASON,
      now,
    });

    // Otra llamada lo canceló justo antes (por ejemplo, dos confirmaciones a la vez): ya quedó cancelado.
    const current = await findCustomerAppointment(db, { tenantId, customerId, appointmentId: appointment.id });
    if (!changed.ok && current?.status !== 'CANCELLED_BY_CUSTOMER') {
      return failure('no_se_pudo_cancelar', 'No se pudo cancelar el turno: ya no se puede cambiar su estado.');
    }
    return cancelledResult(current ?? appointment, ctx, settings, !changed.ok);
  },
};
