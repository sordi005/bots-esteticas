import type { ChangeRefusal } from '../../scheduling/change-policy.js';
import type { CustomerAppointment } from '../../scheduling/customer-appointments.js';
import { formatLocalSlot } from '../format.js';
import { handOff } from '../handoff.js';
import type { AppointmentSettings } from './appointment-summary.js';
import { describeChangeRefusal, type ChangeAction } from './appointment-content.js';
import type { ToolContext, ToolResult } from './tool.js';

/**
 * Cancelar o reprogramar un turno que no corresponde (fuera de plazo, ya empezó, sin
 * reprogramaciones que conserven la seña) lo decide el código, no el modelo (4.6): la herramienta
 * no toca el turno, deriva sola con motivo "excepción" y le devuelve al modelo la política escrita
 * y cuándo le responde una persona, para que la explique sin discutir ni prometer excepciones.
 */

/** Resumen de una línea para la dueña. Sin datos de salud ni de la clienta: el turno, y por qué no corresponde. */
function summaryFor(action: ChangeAction, refusal: ChangeRefusal, slot: string): string {
  const verb = action === 'cancel' ? 'cancelar' : 'reprogramar';
  switch (refusal) {
    case 'too_late':
      return `Pide ${verb} fuera de plazo el turno del ${slot}`;
    case 'already_started':
      return `Pide ${verb} un turno que ya empezó: el del ${slot}`;
    case 'no_reschedules_left':
      return `Pide reprogramar de nuevo el turno del ${slot}: ya usó la reprogramación que conserva la seña`;
  }
}

export async function deriveForPolicy(
  ctx: ToolContext,
  input: {
    action: ChangeAction;
    refusal: ChangeRefusal;
    appointment: CustomerAppointment;
    settings: AppointmentSettings;
  },
): Promise<ToolResult> {
  const { action, refusal, appointment, settings } = input;
  const { motivo, politica } = describeChangeRefusal({ action, reason: refusal, ...settings });

  const { when } = await handOff(ctx.db, {
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
    reason: 'policy_exception',
    summary: summaryFor(action, refusal, formatLocalSlot(appointment.start, ctx.timeZone)),
    now: ctx.now,
  });

  const verb = action === 'cancel' ? 'cancelar' : 'reprogramar';
  return {
    content: {
      [action === 'cancel' ? 'cancelado' : 'reprogramado']: false,
      derivada: true,
      motivo,
      politica,
      cuando: when,
      mensaje:
        `No se pudo ${verb} el turno: ${motivo}. Política: ${politica}. No se cambió nada del turno. ` +
        `La conversación quedó derivada: una persona del equipo le responde por este chat ${when}. ` +
        'Explicale la política con amabilidad y decile cuándo le responde una persona; no discutas ni prometas excepciones.',
    },
    options: [],
    handedOff: true,
  };
}
