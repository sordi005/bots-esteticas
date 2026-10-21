import type { AppointmentStatus } from '../scheduling/appointment-state-machine.js';
import type { handoffReason } from '../conversation/schema.js';
import type { depositStatus } from '../payments/schema.js';
import { formatClockTime, formatLocalSlot, formatPesos } from '../conversation/format.js';
import { choiceIds } from '../conversation/tools/choice-ids.js';
import type { TemplateMessage } from '../whatsapp/outgoing.js';
import { renderTemplate, templateMessage } from '../whatsapp/templates.js';
import { instantToLocal } from '../../shared/time-zone.js';
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

/**
 * La versión con plantilla de cada aviso (8.1, H10): sale si Meta rechaza el mensaje libre por estar
 * fuera de la ventana de 24 horas. Los botones llevan los mismos ids que los del mensaje libre.
 */

/** El comprobante con plantilla. La imagen del encabezado se fija al enviar (8.2). */
export function depositReceiptTemplate(input: {
  notificationId: string;
  appointment: NoticeAppointment;
  amountCents: number;
}): TemplateMessage {
  const { notificationId, appointment } = input;
  return templateMessage('aviso_comprobante', {
    params: { clienta: who(appointment), monto: formatPesos(input.amountCents), turno: describeAppointment(appointment) },
    buttonPayloads: [ownerButtonId(notificationId, 'deposit_received'), ownerButtonId(notificationId, 'deposit_not_received')],
  });
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

/** La derivación con plantilla, con "Ya la atendí". */
export function handoffTemplate(input: {
  notificationId: string;
  appointment: NoticeCustomer;
  reason: HandoffReason;
  summary: string;
  pausedUntil: Date;
}): TemplateMessage {
  const { appointment } = input;
  return templateMessage('aviso_derivacion', {
    params: {
      clienta: who(appointment),
      motivo: REASON_LABELS[input.reason],
      resumen: input.summary,
      hasta: formatLocalSlot(input.pausedUntil, appointment.timeZone),
    },
    buttonPayloads: [ownerButtonId(input.notificationId, 'handoff_attended')],
  });
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

/** El estado de la seña en la plantilla de la cancelación: la variable no puede ir vacía. */
function depositState(deposit: { status: DepositStatus; amountCents: number } | null): string {
  const amount = deposit ? formatPesos(deposit.amountCents) : '';
  switch (deposit?.status) {
    case 'approved':
      return `pagada (${amount}): la devolución o el traspaso los decidís vos`;
    case 'in_review':
      return `en verificación (${amount}): si la transferencia llegó, la devolución o el traspaso los decidís vos`;
    case 'pending':
      return 'sin pagar';
    case 'rejected':
    case 'expired':
    case undefined:
      return 'no llevaba';
  }
}

/** La cancelación con plantilla. */
export function cancellationTemplate(input: {
  appointment: NoticeAppointment;
  deposit: { status: DepositStatus; amountCents: number } | null;
}): TemplateMessage {
  const { appointment } = input;
  return templateMessage('aviso_cancelacion', {
    params: { clienta: appointment.customerName, turno: describeAppointment(appointment), sena: depositState(input.deposit) },
  });
}

/** El asistente reprogramó un turno (4.6). */
export function rescheduleNotice(input: { appointment: NoticeAppointment; previousStart: Date }): TextMessage {
  const { appointment } = input;
  return text(
    `*Reprogramación*\n${appointment.customerName} pasó su turno de ${appointment.serviceName} con ` +
      `${appointment.professionalName} del ${when(appointment, input.previousStart)} al ${when(appointment)}.`,
  );
}

/** La reprogramación con plantilla. */
export function rescheduleTemplate(input: { appointment: NoticeAppointment; previousStart: Date }): TemplateMessage {
  const { appointment } = input;
  return templateMessage('aviso_reprogramacion', {
    params: {
      clienta: appointment.customerName,
      servicio: appointment.serviceName,
      profesional: appointment.professionalName,
      antes: when(appointment, input.previousStart),
      despues: when(appointment),
    },
  });
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

/**
 * Los avisos a la clienta tienen el mismo texto como mensaje libre y como plantilla (4.5, 8.1): el libre
 * es la plantilla con sus variables. Así lo que lee la clienta no depende de por dónde salió.
 */
function asText(template: TemplateMessage): TextMessage {
  const body = renderTemplate(template);
  if (!body) throw new Error(`El código no conoce la plantilla ${template.name}`);
  return text(body);
}

/** A la clienta, con plantilla: la dueña confirmó la transferencia (4.5). */
export function customerDepositConfirmedTemplate(appointment: NoticeAppointment): TemplateMessage {
  return templateMessage('sena_confirmada', {
    params: { servicio: appointment.serviceName, profesional: appointment.professionalName, fecha_hora: when(appointment) },
  });
}

/** A la clienta: la dueña confirmó la transferencia (4.5). */
export function customerDepositConfirmed(appointment: NoticeAppointment): TextMessage {
  return asText(customerDepositConfirmedTemplate(appointment));
}

/** A la clienta, con plantilla: la transferencia no llegó (4.5). */
export function customerDepositRejectedTemplate(appointment: NoticeAppointment): TemplateMessage {
  return templateMessage('sena_rechazada', { params: { fecha_hora: when(appointment) } });
}

/** A la clienta: la transferencia no llegó (4.5). */
export function customerDepositRejected(appointment: NoticeAppointment): TextMessage {
  return asText(customerDepositRejectedTemplate(appointment));
}

/** A la clienta, con plantilla: venció su reserva provisoria (4.5, H10). */
export function reservationExpiredTemplate(appointment: NoticeAppointment): TemplateMessage {
  return templateMessage('reserva_vencida', {
    params: { servicio: appointment.serviceName, fecha_hora: when(appointment) },
  });
}

/** A la clienta: venció su reserva provisoria, y se le ofrece otro horario (4.5, H10). */
export function reservationExpired(appointment: NoticeAppointment): TextMessage {
  return asText(reservationExpiredTemplate(appointment));
}

/** El recordatorio del día anterior (4.7): siempre con plantilla, con "Confirmo", "Reprogramar" y "Cancelar". */
export function appointmentReminder(input: { appointmentId: string; appointment: NoticeAppointment }): TemplateMessage {
  const { appointmentId, appointment } = input;
  return templateMessage('recordatorio_turno', {
    params: { servicio: appointment.serviceName, profesional: appointment.professionalName, fecha_hora: when(appointment) },
    buttonPayloads: [
      choiceIds.reminder(appointmentId, 'confirm'),
      choiceIds.reminder(appointmentId, 'reschedule'),
      choiceIds.reminder(appointmentId, 'cancel'),
    ],
  });
}

/** El recordatorio corto (4.7): la hora y la dirección, sin botones. */
export function shortAppointmentReminder(input: { appointment: NoticeAppointment; address: string }): TemplateMessage {
  const { appointment } = input;
  return templateMessage('recordatorio_turno_corto', {
    params: {
      hora: formatClockTime(instantToLocal(appointment.start, appointment.timeZone).time),
      servicio: appointment.serviceName,
      direccion: input.address,
    },
  });
}
