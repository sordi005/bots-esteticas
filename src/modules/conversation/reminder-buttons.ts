import { holdsSchedule } from '../scheduling/availability.js';
import { countReschedules } from '../scheduling/booking.js';
import { evaluateCustomerCancellation, evaluateCustomerReschedule } from '../scheduling/change-policy.js';
import { findCustomerAppointment, type CustomerAppointment } from '../scheduling/customer-appointments.js';
import type { FreeFormMessage } from '../whatsapp/outgoing.js';
import { formatLocalSlot } from './format.js';
import { displayStatus, loadAppointmentSettings } from './tools/appointment-summary.js';
import { CANCEL_BUTTON_TITLE } from './tools/cancel-appointment.js';
import { choiceIds } from './tools/choice-ids.js';
import type { ResolvedChoice } from './tools/choices.js';
import { deriveForPolicy } from './tools/policy-handoff.js';
import type { ToolContext } from './tools/tool.js';

/**
 * «Cancelar» y «Reprogramar» del recordatorio (4.7, decisión 38): los contesta el código, sin llamar al modelo,
 * con las mismas verificaciones que las herramientas (4.6). La prueba manual de H10 mostró que el modelo los
 * contestaba sin la herramienta aun con el aviso del ciclo, y la respuesta correcta es siempre la misma: pedir
 * la confirmación con «Sí, cancelar» o preguntar para qué día. Si no corresponde, deriva como las herramientas.
 */

type ReminderChoice = Extract<ResolvedChoice, { tipo: 'recordatorio' }>;

const describe = (appointment: CustomerAppointment, timeZone: string) =>
  `${appointment.serviceName} con ${appointment.professionalName} del ${formatLocalSlot(appointment.start, timeZone)}`;

/** La respuesta al botón, o null si el que contesta es el modelo («Confirmo», o un turno que no es de ella). */
export async function answerReminderButton(ctx: ToolContext, choice: ReminderChoice): Promise<FreeFormMessage | null> {
  if (choice.accion === 'confirmar') return null;
  const { db, tenantId, customerId, now, timeZone } = ctx;
  const action = choice.accion === 'cancelar' ? 'cancel' : 'reschedule';
  const verb = choice.accion;

  // El turno sale del botón: tiene que ser de ESTA clienta (regla 2).
  const appointment = await findCustomerAppointment(db, { tenantId, customerId, appointmentId: choice.turnoId });
  if (!appointment) return null;

  const holds = holdsSchedule({ status: appointment.status, depositExpiresAt: appointment.deposit?.expiresAt ?? null }, now);
  if (!holds) {
    return {
      type: 'text',
      body: `Tu turno de ${describe(appointment, timeZone)} ya no está activo (${displayStatus(appointment, now)}), así que no hay nada para ${verb}.`,
    };
  }

  // Lo decide el código, como en cancelar_turno y reprogramar_turno (4.6).
  const settings = await loadAppointmentSettings(db, tenantId);
  const decision =
    action === 'cancel'
      ? evaluateCustomerCancellation({
          appointmentStart: appointment.start,
          now,
          freeCancellationNoticeHours: settings.freeCancellationNoticeHours,
        })
      : evaluateCustomerReschedule({
          appointmentStart: appointment.start,
          now,
          freeCancellationNoticeHours: settings.freeCancellationNoticeHours,
          reschedulesUsed: await countReschedules(db, { tenantId, appointmentId: appointment.id }),
          reschedulesKeepingDeposit: settings.reschedulesKeepingDeposit,
          hasDeposit: appointment.deposit?.status === 'approved' || appointment.deposit?.status === 'in_review',
        });

  if (!decision.allowed) {
    const derived = await deriveForPolicy(ctx, { action, refusal: decision.reason, appointment, settings });
    const { motivo, politica, cuando } = derived.content as { motivo: string; politica: string; cuando: string };
    return {
      type: 'text',
      body:
        `No puedo ${verb} tu turno del ${formatLocalSlot(appointment.start, timeZone)} porque ${motivo}: ${politica}. ` +
        `Le pasé tu consulta a una persona del equipo, que te responde por acá ${cuando}. Tu turno no cambió.`,
    };
  }

  if (action === 'cancel') {
    return {
      type: 'buttons',
      body: `¿Querés cancelar tu turno de ${describe(appointment, timeZone)}? Si es así, tocá «${CANCEL_BUTTON_TITLE}».`,
      buttons: [{ id: choiceIds.cancel(appointment.id), title: CANCEL_BUTTON_TITLE }],
    };
  }
  return {
    type: 'text',
    body:
      `¿Para qué día querés pasar tu turno de ${describe(appointment, timeZone)}? ` +
      'Decime el día y si preferís a la mañana o a la tarde, y te busco horarios.',
  };
}
