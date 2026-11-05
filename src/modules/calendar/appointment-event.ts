import type { AppointmentStatus } from '../scheduling/appointment-state-machine.js';
import type { CalendarEventInput } from './client.js';

/**
 * El evento de un turno en el Google Calendar de la profesional (8.4). Los textos los escribe el
 * código, nunca el modelo, y no llevan el teléfono ni datos de salud. Función pura.
 */

export const APPOINTMENT_EVENT_DESCRIPTION =
  'Turno reservado por WhatsApp. Si lo cambiás acá, el turno no cambia: pedíselo al asistente o avisanos.';

const MINUTE_MS = 60_000;

/** D8: tienen evento los confirmados y los que tienen la seña en verificación (la clienta ya pagó). */
export const STATUSES_WITH_EVENT: readonly AppointmentStatus[] = ['CONFIRMED', 'DEPOSIT_REVIEW'];
/** Completado o ausente: el evento queda en la agenda como historial. */
const KEPT: readonly AppointmentStatus[] = ['COMPLETED', 'NO_SHOW'];

/** El id del evento es el del turno sin guiones (D7): hexadecimal, que entra en el base32hex de Google. */
export const eventIdFor = (appointmentId: string) => appointmentId.replaceAll('-', '');

export type AppointmentEventAction =
  | { kind: 'save'; event: CalendarEventInput }
  | { kind: 'delete'; eventId: string }
  | { kind: 'keep' };

export function appointmentEventAction(appointment: {
  appointmentId: string;
  status: AppointmentStatus;
  serviceName: string;
  customerName: string | null;
  /** El nombre de perfil de WhatsApp, si no dio su nombre (4.9). */
  profileName: string | null;
  start: Date;
  durationMinutes: number;
  timeZone: string;
}): AppointmentEventAction {
  const { appointmentId, status } = appointment;
  if (KEPT.includes(status)) return { kind: 'keep' };
  if (!STATUSES_WITH_EVENT.includes(status)) return { kind: 'delete', eventId: eventIdFor(appointmentId) };

  const tentative = status === 'DEPOSIT_REVIEW';
  const name = appointment.customerName ?? appointment.profileName ?? 'Clienta';
  return {
    kind: 'save',
    event: {
      id: eventIdFor(appointmentId),
      appointmentId,
      summary: `${appointment.serviceName} · ${name}${tentative ? ' (seña en verificación)' : ''}`,
      description: APPOINTMENT_EVENT_DESCRIPTION,
      start: appointment.start,
      // El turno que ve la clienta termina sin el margen (7.2).
      end: new Date(appointment.start.getTime() + appointment.durationMinutes * MINUTE_MS),
      timeZone: appointment.timeZone,
      tentative,
    },
  };
}
