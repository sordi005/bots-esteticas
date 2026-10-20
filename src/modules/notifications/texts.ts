import type { AppointmentStatus } from '../scheduling/appointment-state-machine.js';
import type { handoffReason } from '../conversation/schema.js';
import type { depositStatus } from '../payments/schema.js';
import { formatLocalSlot, formatPesos } from '../conversation/format.js';
import { ownerButtonId } from './owner-buttons.js';

/**
 * Los textos de los avisos (4.5, 4.6, 4.8, 8.2). Los escribe el código, nunca el modelo: fechas y
 * montos en la zona horaria del negocio, y nunca un dato de salud (una derivación por un tema
 * sensible ya trae el resumen fijo, 4.8).
 */

type HandoffReason = (typeof handoffReason.enumValues)[number];
type DepositStatus = (typeof depositStatus.enumValues)[number];

interface TextMessage {
  type: 'text';
  body: string;
}

interface ButtonsMessage {
  type: 'buttons';
  body: string;
  buttons: { id: string; title: string }[];
}

/** La clienta de un aviso. */
export interface NoticeCustomer {
  customerName: string;
  customerPhone: string;
  timeZone: string;
}

/** El turno de un aviso, con su clienta. */
export interface NoticeAppointment extends NoticeCustomer {
  serviceName: string;
  professionalName: string;
  start: Date;
}

const text = (body: string): TextMessage => ({ type: 'text', body });

const who = (customer: NoticeCustomer) => `${customer.customerName} (${customer.customerPhone})`;

const when = (appointment: NoticeAppointment, start = appointment.start) =>
  formatLocalSlot(start, appointment.timeZone);

/** "Esmaltado semipermanente con Mica, lunes 5/10 10:00". */
const describeAppointment = (appointment: NoticeAppointment) =>
  `${appointment.serviceName} con ${appointment.professionalName}, ${when(appointment)}`;

/** Cómo se nombra cada motivo en el aviso a la dueña. */
const REASON_LABELS: Record<HandoffReason, string> = {
  customer_request: 'pidió hablar con una persona',
  complaint: 'queja o reclamo',
  sensitive_topic: 'tema sensible',
  unsupported_media: 'mandó una imagen',
  requires_consultation: 'servicio con consulta previa',
  off_catalog: 'algo que no está en el catálogo',
  policy_exception: 'una excepción a la política',
  not_understood: 'el asistente no la entendió',
  payment_issue: 'un problema con la seña',
};

/** El comprobante, con "Recibida" / "No llegó". El envío le suma la imagen como encabezado. */
export function depositReceiptNotice(input: {
  notificationId: string;
  appointment: NoticeAppointment;
  amountCents: number;
  /** 0 en el primer aviso; 1, 2, 3 en los recordatorios. */
  reminder: number;
}): ButtonsMessage {
  const { notificationId, appointment } = input;
  const title = input.reminder > 0 ? '*Recordatorio* · Comprobante sin responder' : '*Comprobante de seña*';
  return {
    type: 'buttons',
    body:
      `${title}\n${who(appointment)} mandó el comprobante de la seña de ${formatPesos(input.amountCents)} ` +
      `para ${describeAppointment(appointment)}.\n¿Llegó la transferencia?`,
    buttons: [
      { id: ownerButtonId(notificationId, 'deposit_received'), title: 'Recibida' },
      { id: ownerButtonId(notificationId, 'deposit_not_received'), title: 'No llegó' },
    ],
  };
}

/** Una derivación (4.8), con "Ya la atendí". */
export function handoffNotice(input: {
  notificationId: string;
  appointment: NoticeCustomer;
  reason: HandoffReason;
  /** El que se guardó: con un tema sensible, el resumen fijo. */
  summary: string;
  pausedUntil: Date;
}): ButtonsMessage {
  const { appointment } = input;
  return {
    type: 'buttons',
    body:
      `*Derivación*\n${who(appointment)} necesita que la atiendas.\n` +
      `Motivo: ${REASON_LABELS[input.reason]}.\n${input.summary}\n` +
      `El asistente no le contesta hasta el ${formatLocalSlot(input.pausedUntil, appointment.timeZone)}. ` +
      'Escribile desde tu WhatsApp Business y, cuando termines, tocá «Ya la atendí».',
    buttons: [{ id: ownerButtonId(input.notificationId, 'handoff_attended'), title: 'Ya la atendí' }],
  };
}

/** El asistente canceló un turno (4.6). Si había seña pagada o en verificación, la devolución la decide ella. */
export function cancellationNotice(input: {
  appointment: NoticeAppointment;
  deposit: { status: DepositStatus; amountCents: number } | null;
}): TextMessage {
  const { appointment, deposit } = input;
  let depositLine = '';
  if (deposit?.status === 'approved') {
    depositLine = `\nTenía la seña de ${formatPesos(deposit.amountCents)} pagada: la devolución o el traspaso los decidís vos.`;
  } else if (deposit?.status === 'in_review') {
    depositLine =
      `\nTenía un comprobante de ${formatPesos(deposit.amountCents)} en verificación: ` +
      'si la transferencia llegó, la devolución o el traspaso los decidís vos.';
  }
  return text(`*Cancelación*\n${appointment.customerName} canceló su turno: ${describeAppointment(appointment)}.${depositLine}`);
}

/** El asistente reprogramó un turno (4.6). */
export function rescheduleNotice(input: { appointment: NoticeAppointment; previousStart: Date }): TextMessage {
  const { appointment } = input;
  return text(
    `*Reprogramación*\n${appointment.customerName} pasó su turno de ${appointment.serviceName} con ` +
      `${appointment.professionalName} del ${when(appointment, input.previousStart)} al ${when(appointment)}.`,
  );
}

/** Qué pasó con el botón del comprobante que tocó la dueña. */
export function depositReviewAck(
  input:
    | { appointment: NoticeAppointment; outcome: 'CONFIRMED' }
    | { appointment: NoticeAppointment; outcome: 'DEPOSIT_REJECTED' }
    | { appointment: NoticeAppointment; outcome: 'unchanged'; status: AppointmentStatus },
): TextMessage {
  const { appointment } = input;
  const slot = when(appointment);
  if (input.outcome === 'CONFIRMED') {
    return text(`Listo: le avisé a ${appointment.customerName} que su turno del ${slot} quedó confirmado.`);
  }
  if (input.outcome === 'DEPOSIT_REJECTED') {
    return text(
      `Listo: le avisé a ${appointment.customerName} que la transferencia no llegó y el turno del ${slot} quedó sin reservar. ` +
        'El asistente queda en pausa en ese chat para que le escribas vos.',
    );
  }
  switch (input.status) {
    case 'CONFIRMED':
    case 'COMPLETED':
    case 'NO_SHOW':
      return text(`El turno de ${appointment.customerName} del ${slot} ya estaba confirmado: no cambié nada.`);
    case 'DEPOSIT_REJECTED':
      return text(`El comprobante de ${appointment.customerName} ya lo habías marcado como que no llegó: no cambié nada.`);
    case 'CANCELLED_BY_CUSTOMER':
    case 'CANCELLED_BY_BUSINESS':
      return text(
        `${appointment.customerName} canceló ese turno del ${slot}: no cambié nada. Si la seña llegó, la devolución la ves vos.`,
      );
    case 'PENDING_DEPOSIT':
    case 'DEPOSIT_REVIEW':
    case 'EXPIRED':
      return text(`El turno de ${appointment.customerName} del ${slot} ya no está esperando la seña: no cambié nada.`);
  }
}

/** Qué pasó con "Ya la atendí". */
export function handoffAttendedAck(input: {
  customerName: string;
  outcome: 'resumed' | 'resolved' | 'already_resolved';
}): TextMessage {
  switch (input.outcome) {
    case 'resumed':
      return text(`Listo, la marqué como atendida. El asistente vuelve a contestar en el chat de ${input.customerName}.`);
    case 'resolved':
      return text(`Listo, la marqué como atendida.`);
    case 'already_resolved':
      return text(`La derivación de ${input.customerName} ya estaba atendida: no cambié nada.`);
  }
}

/** A la clienta: la dueña confirmó la transferencia (4.5). */
export function customerDepositConfirmed(appointment: NoticeAppointment): TextMessage {
  return text(
    `¡Seña recibida! Tu turno quedó confirmado: ${when(appointment)}, ${appointment.serviceName} con ${appointment.professionalName}.`,
  );
}

/** A la clienta: la transferencia no llegó (4.5). */
export function customerDepositRejected(appointment: NoticeAppointment): TextMessage {
  return text(
    `No pudimos verificar la transferencia de la seña, así que el turno del ${when(appointment)} quedó sin reservar. ` +
      'Si ya la hiciste, una persona del equipo te escribe por acá.',
  );
}
