import { describe, expect, it } from 'vitest';
import {
  evaluateCustomerCancellation,
  evaluateCustomerReschedule,
  reschedulesRemaining,
} from '../../../src/modules/scheduling/change-policy.js';

const HOUR_MS = 60 * 60 * 1000;
const appointmentStart = new Date('2026-10-06T18:30:00.000Z');
const hoursBefore = (hours: number) => new Date(appointmentStart.getTime() - hours * HOUR_MS);

describe('evaluateCustomerCancellation (sección 4.6)', () => {
  const policy = { appointmentStart, freeCancellationNoticeHours: 24 };

  it.each([
    ['con más anticipación que la política', 30],
    ['justo en el límite de 24 horas', 24],
  ])('%s, el asistente cancela solo', (_case, hours) => {
    expect(evaluateCustomerCancellation({ ...policy, now: hoursBefore(hours) })).toEqual({
      allowed: true,
    });
  });

  it('fuera de plazo, deriva a la dueña', () => {
    expect(evaluateCustomerCancellation({ ...policy, now: hoursBefore(23.99) })).toEqual({
      allowed: false,
      reason: 'too_late',
    });
  });

  it('un turno que ya empezó no se cancela por el asistente', () => {
    expect(evaluateCustomerCancellation({ ...policy, now: hoursBefore(-0.5) })).toEqual({
      allowed: false,
      reason: 'already_started',
    });
  });

  it('sin plazo configurado, se puede cancelar hasta que empiece', () => {
    expect(
      evaluateCustomerCancellation({ ...policy, freeCancellationNoticeHours: 0, now: hoursBefore(0.1) }),
    ).toEqual({ allowed: true });
  });
});

describe('evaluateCustomerReschedule (sección 4.6)', () => {
  const policy = {
    appointmentStart,
    freeCancellationNoticeHours: 24,
    reschedulesKeepingDeposit: 1,
    hasDeposit: true,
  };

  it('dentro de plazo y con reprogramaciones disponibles, conserva la seña', () => {
    expect(
      evaluateCustomerReschedule({ ...policy, reschedulesUsed: 0, now: hoursBefore(48) }),
    ).toEqual({ allowed: true });
  });

  it('si ya usó las reprogramaciones que conservan la seña, deriva a la dueña', () => {
    expect(
      evaluateCustomerReschedule({ ...policy, reschedulesUsed: 1, now: hoursBefore(48) }),
    ).toEqual({ allowed: false, reason: 'no_reschedules_left' });
  });

  it('sin seña no hay límite de reprogramaciones', () => {
    expect(
      evaluateCustomerReschedule({
        ...policy,
        hasDeposit: false,
        reschedulesUsed: 3,
        now: hoursBefore(48),
      }),
    ).toEqual({ allowed: true });
  });

  it('fuera de plazo, deriva a la dueña aunque le queden reprogramaciones', () => {
    expect(
      evaluateCustomerReschedule({ ...policy, reschedulesUsed: 0, now: hoursBefore(2) }),
    ).toEqual({ allowed: false, reason: 'too_late' });
  });
});

describe('reschedulesRemaining', () => {
  it.each([
    [1, 0, 1],
    [1, 1, 0],
    [2, 1, 1],
    [1, 3, 0],
  ])('con %i permitidas y %i usadas quedan %i', (allowed, used, remaining) => {
    expect(reschedulesRemaining({ allowed, used })).toBe(remaining);
  });
});
