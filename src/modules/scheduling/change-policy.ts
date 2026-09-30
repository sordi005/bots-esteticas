/**
 * Cancelación y reprogramación pedidas por la clienta (sección 4.6). Funciones puras.
 * Si está permitido, el asistente lo resuelve solo; si no, informa la política y deriva
 * a la dueña, que decide las excepciones.
 */
export type ChangeRefusal = 'too_late' | 'already_started' | 'no_reschedules_left';

export type ChangeDecision = { allowed: true } | { allowed: false; reason: ChangeRefusal };

const HOUR_MS = 60 * 60 * 1000;

interface WindowInput {
  appointmentStart: Date;
  now: Date;
  /** "Cancelación con devolución o traspaso con al menos X horas de anticipación". */
  freeCancellationNoticeHours: number;
}

function checkWindow({ appointmentStart, now, freeCancellationNoticeHours }: WindowInput): ChangeDecision {
  const start = appointmentStart.getTime();
  if (now.getTime() >= start) {
    return { allowed: false, reason: 'already_started' };
  }
  // "Con al menos X horas": justo X horas antes todavía está dentro de plazo.
  if (now.getTime() > start - freeCancellationNoticeHours * HOUR_MS) {
    return { allowed: false, reason: 'too_late' };
  }
  return { allowed: true };
}

export function evaluateCustomerCancellation(input: WindowInput): ChangeDecision {
  return checkWindow(input);
}

export function evaluateCustomerReschedule(
  input: WindowInput & {
    reschedulesUsed: number;
    /** Cuántas reprogramaciones conservan la seña (sección 4.5). */
    reschedulesKeepingDeposit: number;
    hasDeposit: boolean;
  },
): ChangeDecision {
  const window = checkWindow(input);
  if (!window.allowed) return window;

  const remaining = reschedulesRemaining({
    allowed: input.reschedulesKeepingDeposit,
    used: input.reschedulesUsed,
  });
  if (input.hasDeposit && remaining === 0) {
    return { allowed: false, reason: 'no_reschedules_left' };
  }
  return { allowed: true };
}

export function reschedulesRemaining({ allowed, used }: { allowed: number; used: number }): number {
  return Math.max(0, allowed - used);
}
