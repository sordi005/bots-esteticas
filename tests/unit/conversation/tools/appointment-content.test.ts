import { describe, expect, it } from 'vitest';
import { APPOINTMENT_STATUSES } from '../../../../src/modules/scheduling/appointment-state-machine.js';
import {
  describeAppointmentStatus,
  describeChangeRefusal,
  describeDepositMethod,
  describeDepositStatus,
  describePolicy,
  formatDeadline,
} from '../../../../src/modules/conversation/tools/appointment-content.js';

const MENDOZA = 'America/Argentina/Mendoza';
// Viernes 9/10/2026 a las 10:00 en Mendoza (UTC-3).
const NOW = new Date('2026-10-09T13:00:00.000Z');

describe('describeAppointmentStatus: el estado del turno en español para la clienta', () => {
  it('escribe los estados que ocupan el horario como los entiende la clienta', () => {
    expect(describeAppointmentStatus('CONFIRMED')).toBe('confirmado');
    expect(describeAppointmentStatus('PENDING_DEPOSIT')).toBe('pendiente de seña');
    expect(describeAppointmentStatus('DEPOSIT_REVIEW')).toBe('seña en verificación');
    expect(describeAppointmentStatus('CANCELLED_BY_CUSTOMER')).toBe('cancelado');
  });

  it('todos los estados tienen un texto distinto y sin nombres del código', () => {
    const texts = APPOINTMENT_STATUSES.map(describeAppointmentStatus);

    expect(new Set(texts).size).toBe(APPOINTMENT_STATUSES.length);
    for (const text of texts) expect(text).not.toMatch(/[A-Z_]{4,}/);
  });
});

describe('describeDepositStatus: el estado de la seña en español', () => {
  it('cada estado tiene su texto', () => {
    expect(describeDepositStatus('pending')).toBe('pendiente de pago');
    expect(describeDepositStatus('in_review')).toBe('en verificación');
    expect(describeDepositStatus('approved')).toBe('pagada');
    expect(describeDepositStatus('rejected')).toBe('rechazada');
    expect(describeDepositStatus('expired')).toBe('vencida');
  });
});

describe('describeDepositMethod: el medio que eligió el negocio', () => {
  it('transferencia y Mercado Pago', () => {
    expect(describeDepositMethod('transfer')).toBe('transferencia');
    expect(describeDepositMethod('mercadopago')).toBe('Mercado Pago');
  });
});

describe('formatDeadline: hasta cuándo, con el día solo si no es hoy', () => {
  it('hoy: "hoy a las 11:00"', () => {
    expect(formatDeadline(new Date('2026-10-09T14:00:00.000Z'), NOW, MENDOZA)).toBe('hoy a las 11:00');
  });

  it('otro día: lleva el día de la semana y la fecha', () => {
    expect(formatDeadline(new Date('2026-10-10T12:30:00.000Z'), NOW, MENDOZA)).toBe('el sábado 10/10 a las 9:30');
  });

  it('compara los días en la zona del negocio: 02:00 UTC todavía es el día anterior en Mendoza', () => {
    // 10/10 02:00 UTC = viernes 9/10 23:00 en Mendoza: es hoy.
    expect(formatDeadline(new Date('2026-10-10T02:00:00.000Z'), NOW, MENDOZA)).toBe('hoy a las 23:00');
  });
});

describe('describePolicy: la política de plazo escrita por el código', () => {
  it('cancelar y reprogramar con el plazo del negocio', () => {
    expect(describePolicy('cancel', 24)).toBe('se cancela sin costo con al menos 24 horas de anticipación');
    expect(describePolicy('reschedule', 48)).toBe('se reprograma sin costo con al menos 48 horas de anticipación');
  });

  it('una hora va en singular', () => {
    expect(describePolicy('cancel', 1)).toBe('se cancela sin costo con al menos 1 hora de anticipación');
  });

  it('sin plazo (0 horas): hasta que empieza el turno', () => {
    expect(describePolicy('cancel', 0)).toBe('se cancela sin costo hasta que empieza el turno');
  });
});

describe('describeChangeRefusal: por qué no corresponde y cuál es la política', () => {
  const settings = { freeCancellationNoticeHours: 24, reschedulesKeepingDeposit: 1 };

  it('cancelar fuera de plazo', () => {
    expect(describeChangeRefusal({ action: 'cancel', reason: 'too_late', ...settings })).toEqual({
      motivo: 'faltan menos de 24 horas para el turno',
      politica: 'se cancela sin costo con al menos 24 horas de anticipación',
    });
  });

  it('un turno que ya empezó', () => {
    expect(describeChangeRefusal({ action: 'reschedule', reason: 'already_started', ...settings })).toEqual({
      motivo: 'el turno ya empezó',
      politica: 'se reprograma sin costo con al menos 24 horas de anticipación',
    });
  });

  it('reprogramar sin reprogramaciones que conserven la seña', () => {
    expect(describeChangeRefusal({ action: 'reschedule', reason: 'no_reschedules_left', ...settings })).toEqual({
      motivo: 'ya usaste la reprogramación que conserva la seña',
      politica: 'con la seña paga se puede reprogramar 1 vez conservando la seña',
    });
  });

  it('con más de una reprogramación permitida va en plural', () => {
    expect(
      describeChangeRefusal({
        action: 'reschedule',
        reason: 'no_reschedules_left',
        ...settings,
        reschedulesKeepingDeposit: 2,
      }),
    ).toEqual({
      motivo: 'ya usaste las 2 reprogramaciones que conservan la seña',
      politica: 'con la seña paga se puede reprogramar 2 veces conservando la seña',
    });
  });

  it('si el negocio no permite ninguna, no dice que ya la usó', () => {
    const refusal = describeChangeRefusal({
      action: 'reschedule',
      reason: 'no_reschedules_left',
      ...settings,
      reschedulesKeepingDeposit: 0,
    });

    expect(refusal).toEqual({
      motivo: 'con la seña paga no se puede reprogramar conservándola',
      politica: 'este negocio no conserva la seña al reprogramar',
    });
  });
});
