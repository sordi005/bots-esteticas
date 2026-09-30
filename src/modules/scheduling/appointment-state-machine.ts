/**
 * Máquina de estados de un turno (sección 4.4, CLAUDE.md regla 4).
 * Es el único lugar del código que define estados y transiciones: el esquema de la base
 * importa los estados de acá. Cualquier transición que no esté en la tabla es un error.
 */
export const APPOINTMENT_STATUSES = [
  'PENDING_DEPOSIT',
  'DEPOSIT_REVIEW',
  'CONFIRMED',
  'DEPOSIT_REJECTED',
  'EXPIRED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED_BY_CUSTOMER',
  'CANCELLED_BY_BUSINESS',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Quién hace algo: el asistente, la dueña, una tarea programada o el administrador. */
export const ACTORS = ['assistant', 'owner', 'system', 'admin'] as const;

export type Actor = (typeof ACTORS)[number];

const PEOPLE = ['owner', 'admin'] as const satisfies readonly Actor[];
const ASSISTANT_OR_PEOPLE = ['assistant', ...PEOPLE] as const satisfies readonly Actor[];

interface TransitionRule {
  /** `null`: creación del turno. */
  from: AppointmentStatus | null;
  to: AppointmentStatus;
  actors: readonly Actor[];
}

const TRANSITIONS: readonly TransitionRule[] = [
  // Creación: con seña queda pendiente; sin seña, confirmado directo.
  { from: null, to: 'PENDING_DEPOSIT', actors: ASSISTANT_OR_PEOPLE },
  { from: null, to: 'CONFIRMED', actors: ASSISTANT_OR_PEOPLE },

  // Seña pendiente
  { from: 'PENDING_DEPOSIT', to: 'DEPOSIT_REVIEW', actors: ASSISTANT_OR_PEOPLE },
  // Mercado Pago confirma por webhook (sistema); la dueña puede confirmar a mano.
  { from: 'PENDING_DEPOSIT', to: 'CONFIRMED', actors: ['system', ...PEOPLE] },
  { from: 'PENDING_DEPOSIT', to: 'EXPIRED', actors: ['system'] },
  { from: 'PENDING_DEPOSIT', to: 'CANCELLED_BY_CUSTOMER', actors: ASSISTANT_OR_PEOPLE },
  { from: 'PENDING_DEPOSIT', to: 'CANCELLED_BY_BUSINESS', actors: PEOPLE },

  // Seña en verificación: una transferencia la confirma o rechaza siempre una persona (4.5).
  // No vence sola: si la dueña no contesta, se le vuelve a avisar.
  { from: 'DEPOSIT_REVIEW', to: 'CONFIRMED', actors: PEOPLE },
  { from: 'DEPOSIT_REVIEW', to: 'DEPOSIT_REJECTED', actors: PEOPLE },
  { from: 'DEPOSIT_REVIEW', to: 'CANCELLED_BY_CUSTOMER', actors: ASSISTANT_OR_PEOPLE },
  { from: 'DEPOSIT_REVIEW', to: 'CANCELLED_BY_BUSINESS', actors: PEOPLE },

  // Confirmado. Reprogramar no cambia el estado: se registra como evento aparte.
  { from: 'CONFIRMED', to: 'COMPLETED', actors: ['system', ...PEOPLE] },
  { from: 'CONFIRMED', to: 'NO_SHOW', actors: PEOPLE },
  { from: 'CONFIRMED', to: 'CANCELLED_BY_CUSTOMER', actors: ASSISTANT_OR_PEOPLE },
  { from: 'CONFIRMED', to: 'CANCELLED_BY_BUSINESS', actors: PEOPLE },
];

/** Mientras está en uno de estos estados, el turno ocupa el horario (sección 6.6). */
const SCHEDULE_OCCUPYING_STATUSES: readonly AppointmentStatus[] = [
  'PENDING_DEPOSIT',
  'DEPOSIT_REVIEW',
  'CONFIRMED',
];

export function canTransition(
  from: AppointmentStatus | null,
  to: AppointmentStatus,
  actor: Actor,
): boolean {
  return TRANSITIONS.some(
    (rule) => rule.from === from && rule.to === to && rule.actors.includes(actor),
  );
}

export function isFinalStatus(status: AppointmentStatus): boolean {
  return !TRANSITIONS.some((rule) => rule.from === status);
}

export function occupiesSchedule(status: AppointmentStatus): boolean {
  return SCHEDULE_OCCUPYING_STATUSES.includes(status);
}

export class InvalidTransitionError extends Error {
  override name = 'InvalidTransitionError';
}

/** Evento de auditoría de una transición: se guarda en `appointment_events`. */
export interface AppointmentTransition {
  fromStatus: AppointmentStatus | null;
  toStatus: AppointmentStatus;
  actor: Actor;
  reason: string | null;
  occurredAt: Date;
}

export function transition(input: {
  from: AppointmentStatus | null;
  to: AppointmentStatus;
  actor: Actor;
  reason?: string;
  at: Date;
}): AppointmentTransition {
  const { from, to, actor, reason, at } = input;
  if (!canTransition(from, to, actor)) {
    throw new InvalidTransitionError(
      `Transición no permitida: ${from ?? 'creación'} → ${to} por ${actor}`,
    );
  }
  return { fromStatus: from, toStatus: to, actor, reason: reason ?? null, occurredAt: at };
}
