import { describe, expect, it } from 'vitest';
import {
  ACTORS,
  APPOINTMENT_STATUSES,
  canReschedule,
  canTransition,
  InvalidTransitionError,
  isFinalStatus,
  occupiesSchedule,
  rescheduleEvent,
  transition,
  type Actor,
  type AppointmentStatus,
} from '../../../src/modules/scheduling/appointment-state-machine.js';

// Escrita a mano a partir de la sección 4.4 de la especificación: no se deriva del código.
const PEOPLE: Actor[] = ['owner', 'admin'];
const EXPECTED_TRANSITIONS: [AppointmentStatus | null, AppointmentStatus, Actor[]][] = [
  // Creación: con seña queda pendiente; sin seña, confirmado.
  [null, 'PENDING_DEPOSIT', ['assistant', ...PEOPLE]],
  [null, 'CONFIRMED', ['assistant', ...PEOPLE]],
  // Seña pendiente
  ['PENDING_DEPOSIT', 'DEPOSIT_REVIEW', ['assistant', ...PEOPLE]],
  ['PENDING_DEPOSIT', 'CONFIRMED', ['system', ...PEOPLE]],
  ['PENDING_DEPOSIT', 'EXPIRED', ['system']],
  ['PENDING_DEPOSIT', 'CANCELLED_BY_CUSTOMER', ['assistant', ...PEOPLE]],
  ['PENDING_DEPOSIT', 'CANCELLED_BY_BUSINESS', PEOPLE],
  // Seña en verificación: solo una persona confirma o rechaza una transferencia (4.5).
  ['DEPOSIT_REVIEW', 'CONFIRMED', PEOPLE],
  ['DEPOSIT_REVIEW', 'DEPOSIT_REJECTED', PEOPLE],
  ['DEPOSIT_REVIEW', 'CANCELLED_BY_CUSTOMER', ['assistant', ...PEOPLE]],
  ['DEPOSIT_REVIEW', 'CANCELLED_BY_BUSINESS', PEOPLE],
  // Confirmado
  ['CONFIRMED', 'COMPLETED', ['system', ...PEOPLE]],
  ['CONFIRMED', 'NO_SHOW', PEOPLE],
  ['CONFIRMED', 'CANCELLED_BY_CUSTOMER', ['assistant', ...PEOPLE]],
  ['CONFIRMED', 'CANCELLED_BY_BUSINESS', PEOPLE],
];

function isExpected(from: AppointmentStatus | null, to: AppointmentStatus, actor: Actor): boolean {
  return EXPECTED_TRANSITIONS.some(
    ([expectedFrom, expectedTo, actors]) =>
      expectedFrom === from && expectedTo === to && actors.includes(actor),
  );
}

const ALL_COMBINATIONS = [null, ...APPOINTMENT_STATUSES].flatMap((from) =>
  APPOINTMENT_STATUSES.flatMap((to) => ACTORS.map((actor) => ({ from, to, actor }))),
);

describe('máquina de estados de un turno', () => {
  it('conoce los nueve estados y los cuatro actores de la especificación', () => {
    expect([...APPOINTMENT_STATUSES].sort()).toEqual(
      [
        'CANCELLED_BY_BUSINESS',
        'CANCELLED_BY_CUSTOMER',
        'COMPLETED',
        'CONFIRMED',
        'DEPOSIT_REJECTED',
        'DEPOSIT_REVIEW',
        'EXPIRED',
        'NO_SHOW',
        'PENDING_DEPOSIT',
      ],
    );
    expect([...ACTORS].sort()).toEqual(['admin', 'assistant', 'owner', 'system']);
  });

  it('permite exactamente las transiciones de la especificación, y cada una solo a sus actores', () => {
    const disagreements = ALL_COMBINATIONS.filter(
      ({ from, to, actor }) => canTransition(from, to, actor) !== isExpected(from, to, actor),
    ).map(({ from, to, actor }) => `${from ?? 'creación'} → ${to} por ${actor}`);

    expect(ALL_COMBINATIONS).toHaveLength(10 * 9 * 4);
    expect(disagreements).toEqual([]);
  });

  it('el asistente nunca confirma una transferencia: lo hace una persona (4.5)', () => {
    expect(canTransition('DEPOSIT_REVIEW', 'CONFIRMED', 'assistant')).toBe(false);
    expect(canTransition('DEPOSIT_REVIEW', 'CONFIRMED', 'owner')).toBe(true);
  });

  it('una seña en verificación no vence sola', () => {
    expect(ACTORS.some((actor) => canTransition('DEPOSIT_REVIEW', 'EXPIRED', actor))).toBe(false);
  });

  it.each([
    ['COMPLETED'],
    ['NO_SHOW'],
    ['CANCELLED_BY_CUSTOMER'],
    ['CANCELLED_BY_BUSINESS'],
    ['EXPIRED'],
    ['DEPOSIT_REJECTED'],
  ] as const)('%s es un estado final: no sale de ahí', (status) => {
    expect(isFinalStatus(status)).toBe(true);
    const exits = APPOINTMENT_STATUSES.filter((to) =>
      ACTORS.some((actor) => canTransition(status, to, actor)),
    );
    expect(exits).toEqual([]);
  });

  it.each([['PENDING_DEPOSIT'], ['DEPOSIT_REVIEW'], ['CONFIRMED']] as const)(
    '%s todavía puede cambiar y ocupa el horario de la profesional',
    (status) => {
      expect(isFinalStatus(status)).toBe(false);
      expect(occupiesSchedule(status)).toBe(true);
    },
  );

  it('los estados finales liberan el horario', () => {
    const occupying = APPOINTMENT_STATUSES.filter(occupiesSchedule);
    expect(occupying.sort()).toEqual(['CONFIRMED', 'DEPOSIT_REVIEW', 'PENDING_DEPOSIT']);
  });
});

describe('transition', () => {
  const at = new Date('2026-10-05T15:00:00.000Z');

  it('devuelve el evento de auditoría que hay que guardar (regla 4)', () => {
    expect(
      transition({
        from: 'DEPOSIT_REVIEW',
        to: 'CONFIRMED',
        actor: 'owner',
        reason: 'La dueña marcó la transferencia como recibida',
        at,
      }),
    ).toEqual({
      kind: 'status_change',
      fromStatus: 'DEPOSIT_REVIEW',
      toStatus: 'CONFIRMED',
      actor: 'owner',
      reason: 'La dueña marcó la transferencia como recibida',
      previousTimeRange: null,
      occurredAt: at,
    });
  });

  it('registra la creación de un turno como transición desde ningún estado', () => {
    expect(transition({ from: null, to: 'CONFIRMED', actor: 'assistant', at })).toEqual({
      kind: 'status_change',
      fromStatus: null,
      toStatus: 'CONFIRMED',
      actor: 'assistant',
      reason: null,
      previousTimeRange: null,
      occurredAt: at,
    });
  });

  it('rechaza una transición inválida con un error que dice cuál fue', () => {
    expect(() => transition({ from: 'COMPLETED', to: 'CONFIRMED', actor: 'admin', at })).toThrow(
      InvalidTransitionError,
    );
    expect(() =>
      transition({ from: 'DEPOSIT_REVIEW', to: 'CONFIRMED', actor: 'assistant', at }),
    ).toThrow('DEPOSIT_REVIEW → CONFIRMED por assistant');
  });
});

describe('rescheduleEvent: reprogramar cambia el horario, no el estado', () => {
  const at = new Date('2026-10-05T15:00:00.000Z');
  const previousTimeRange = {
    start: new Date('2026-10-06T13:00:00.000Z'),
    end: new Date('2026-10-06T14:10:00.000Z'),
  };

  it('devuelve el evento de auditoría con el horario anterior', () => {
    expect(
      rescheduleEvent({
        status: 'CONFIRMED',
        previousTimeRange,
        actor: 'assistant',
        reason: 'La clienta pidió pasarlo al jueves',
        at,
      }),
    ).toEqual({
      kind: 'rescheduled',
      fromStatus: 'CONFIRMED',
      toStatus: 'CONFIRMED',
      actor: 'assistant',
      reason: 'La clienta pidió pasarlo al jueves',
      previousTimeRange,
      occurredAt: at,
    });
  });

  it.each([['PENDING_DEPOSIT'], ['DEPOSIT_REVIEW'], ['CONFIRMED']] as const)(
    'un turno %s se puede reprogramar',
    (status) => {
      expect(canReschedule(status, 'owner')).toBe(true);
    },
  );

  it('un turno que ya terminó o se canceló no se reprograma', () => {
    const reschedulable = APPOINTMENT_STATUSES.filter((status) => canReschedule(status, 'admin'));

    expect(reschedulable.sort()).toEqual(['CONFIRMED', 'DEPOSIT_REVIEW', 'PENDING_DEPOSIT']);
    expect(() =>
      rescheduleEvent({ status: 'COMPLETED', previousTimeRange, actor: 'owner', at }),
    ).toThrow(InvalidTransitionError);
  });

  it('una tarea programada no reprograma turnos: lo pide la clienta o la dueña', () => {
    expect(canReschedule('CONFIRMED', 'system')).toBe(false);
    expect(canReschedule('CONFIRMED', 'assistant')).toBe(true);
  });
});
