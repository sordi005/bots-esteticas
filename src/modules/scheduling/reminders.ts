import {
  addDaysToLocalDate,
  instantToLocal,
  localDateTimeToInstant,
  parseLocalTime,
  type LocalTime,
} from '../../shared/time-zone.js';

/**
 * Cuándo sale cada recordatorio (sección 4.7). Funciones puras: la tarea programada
 * (H10) las usa para agendarlos, en la zona horaria del negocio.
 */
export interface ReminderWindow {
  /** Hora local desde la que se puede enviar, por ejemplo "09:00". */
  start: LocalTime;
  /** Hora local hasta la que se puede enviar, incluida, por ejemplo "21:00". */
  end: LocalTime;
}

interface ReminderInput {
  appointmentStart: Date;
  /** Cuándo se reservó el turno. */
  bookedAt: Date;
  timeZone: string;
  window: ReminderWindow;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Recordatorio principal: el día anterior, a la misma hora local del turno.
 * Fuera de la ventana se adelanta al último horario permitido. Se omite si el turno se
 * reservó con menos de 24 horas o si el horario resultante ya pasó al reservar.
 */
export function dayBeforeReminderAt(input: ReminderInput): Date | null {
  const { appointmentStart, bookedAt, timeZone, window } = input;
  if (appointmentStart.getTime() - bookedAt.getTime() < 24 * HOUR_MS) {
    return null;
  }

  const appointment = instantToLocal(appointmentStart, timeZone);
  const dayBefore = addDaysToLocalDate(appointment.date, -1);

  let reminder: Date;
  if (appointment.minutesOfDay < parseLocalTime(window.start)) {
    // Muy temprano: el último horario permitido antes es el cierre de la ventana del día previo.
    reminder = localDateTimeToInstant(addDaysToLocalDate(dayBefore, -1), window.end, timeZone);
  } else if (appointment.minutesOfDay > parseLocalTime(window.end)) {
    reminder = localDateTimeToInstant(dayBefore, window.end, timeZone);
  } else {
    reminder = localDateTimeToInstant(dayBefore, appointment.time, timeZone);
  }

  return reminder.getTime() > bookedAt.getTime() ? reminder : null;
}

/** Recordatorio corto opcional, `hoursBefore` horas antes. Fuera de la ventana, se omite. */
export function shortReminderAt(input: ReminderInput & { hoursBefore?: number }): Date | null {
  const { appointmentStart, bookedAt, timeZone, window, hoursBefore = 2 } = input;
  const reminder = new Date(appointmentStart.getTime() - hoursBefore * HOUR_MS);
  const { minutesOfDay } = instantToLocal(reminder, timeZone);

  const insideWindow =
    minutesOfDay >= parseLocalTime(window.start) && minutesOfDay <= parseLocalTime(window.end);
  return insideWindow && reminder.getTime() > bookedAt.getTime() ? reminder : null;
}
