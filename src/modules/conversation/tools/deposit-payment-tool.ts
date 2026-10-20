import { z } from 'zod';
import { findCustomerAppointment } from '../../scheduling/customer-appointments.js';
import { displayStatus, isExpiredPending } from './appointment-summary.js';
import { choiceIds, parseAppointmentRef } from './choice-ids.js';
import { depositPayment, derivedPaymentMessage, PAYMENT_INSTRUCTIONS } from './deposit-payment.js';
import type { AgentTool, ToolResult } from './tool.js';

const input = z.object({
  turno_id: z
    .string()
    .describe('Id del turno, TAL CUAL lo devolvió listar_turnos_de_la_clienta (turnoId) o el contexto (turno_id=…).'),
});

type Input = z.infer<typeof input>;

const failure = (motivo: string, mensaje: string): ToolResult => ({
  content: { motivo, mensaje },
  options: [],
  isError: true,
});

const noPayment = (turnoId: string, mensaje: string): ToolResult => ({
  content: { turnoId, mensaje },
  options: [],
});

/**
 * `generar_pago_sena(turno_id)` (6.4, 4.5): los datos para pagar la seña de un turno de la clienta,
 * cuando los pide de nuevo (`crear_reserva` ya los da al reservar). Solo con la seña pendiente y en
 * plazo; si no hay cómo cobrarla por acá, deriva sola. No cambia nada del turno.
 */
export const depositPaymentTool: AgentTool<Input> = {
  name: 'generar_pago_sena',
  description:
    'Devuelve los datos para pagar la seña de un turno de la clienta (alias o CBU, titular, monto y hasta cuándo), ' +
    'ya escritos. Usala cuando la clienta pide de nuevo los datos para pagar; al reservar no hace falta: ' +
    'crear_reserva ya los devuelve. Si la seña ya no está pendiente (el comprobante está en verificación, ya está ' +
    'pagada o el plazo venció), lo dice. Si no hay cómo cobrarla por acá, deriva sola a una persona.',
  input,
  async run({ turno_id }, ctx) {
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
    const turnoId = choiceIds.appointment(appointment.id);

    switch (appointment.status) {
      case 'DEPOSIT_REVIEW':
        return noPayment(
          turnoId,
          'Ya mandó el comprobante: una persona del equipo verifica la transferencia y le avisa por acá. No hay que pagar de nuevo ni está confirmado todavía.',
        );
      case 'CONFIRMED':
      case 'COMPLETED':
        return noPayment(turnoId, 'Ese turno está confirmado: no hay nada para pagar.');
      case 'PENDING_DEPOSIT':
        break;
      default:
        return noPayment(turnoId, `Ese turno ya no espera la seña (${displayStatus(appointment, now)}): no hay nada para pagar.`);
    }
    if (isExpiredPending(appointment, now)) {
      return noPayment(
        turnoId,
        'El plazo para pagar la seña venció: el horario se puede liberar en cualquier momento. No le pases datos para pagar; ofrecele volver a reservar.',
      );
    }

    const payment = await depositPayment(ctx, appointment);
    if (!payment) return noPayment(turnoId, 'Ese turno no tiene una seña pendiente: no hay nada para pagar.');
    if (payment.kind === 'derived') {
      return {
        content: { turnoId, derivada: true, cuando: payment.when, mensaje: derivedPaymentMessage(payment.when) },
        options: [],
      };
    }
    return {
      content: { turnoId, pago: payment.content, mensaje: PAYMENT_INSTRUCTIONS },
      options: [],
      mustMention: payment.mustMention,
    };
  },
};
