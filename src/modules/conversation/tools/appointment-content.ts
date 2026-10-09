import { instantToLocal } from '../../../shared/time-zone.js';
import type { AppointmentStatus } from '../../scheduling/appointment-state-machine.js';
import type { ChangeRefusal } from '../../scheduling/change-policy.js';
import type { depositStatus } from '../../payments/schema.js';
import type { depositPaymentOptions } from '../../tenants/schema.js';
import { formatClockTime, formatLocalDate } from '../format.js';

/**
 * Cómo se le cuenta un turno, su seña y la política de cambios al modelo y a la clienta: los
 * estados, las fechas y los plazos salen escritos por el código (6.4), el modelo no los calcula.
 */

const STATUS_TEXT: Record<AppointmentStatus, string> = {
  PENDING_DEPOSIT: 'pendiente de seña',
  DEPOSIT_REVIEW: 'seña en verificación',
  CONFIRMED: 'confirmado',
  DEPOSIT_REJECTED: 'seña rechazada',
  EXPIRED: 'vencido por falta de seña',
  COMPLETED: 'completado',
  NO_SHOW: 'ausente',
  CANCELLED_BY_CUSTOMER: 'cancelado',
  CANCELLED_BY_BUSINESS: 'cancelado por el negocio',
};

export function describeAppointmentStatus(status: AppointmentStatus): string {
  return STATUS_TEXT[status];
}

const DEPOSIT_STATUS_TEXT: Record<(typeof depositStatus.enumValues)[number], string> = {
  pending: 'pendiente de pago',
  in_review: 'en verificación',
  approved: 'pagada',
  rejected: 'rechazada',
  expired: 'vencida',
};

export function describeDepositStatus(status: (typeof depositStatus.enumValues)[number]): string {
  return DEPOSIT_STATUS_TEXT[status];
}

/** El medio de la seña lo elige el negocio, uno solo (4.5). */
export function describeDepositMethod(option: (typeof depositPaymentOptions.enumValues)[number]): string {
  return option === 'mercadopago' ? 'Mercado Pago' : 'transferencia';
}

/** "hoy a las 11:00" o, si no es hoy, "el sábado 10/10 a las 9:30": los días se comparan en la zona del negocio. */
export function formatDeadline(deadline: Date, now: Date, timeZone: string): string {
  const local = instantToLocal(deadline, timeZone);
  const time = formatClockTime(local.time);
  if (local.date === instantToLocal(now, timeZone).date) return `hoy a las ${time}`;
  return `el ${formatLocalDate(local.date)} a las ${time}`;
}

export type ChangeAction = 'cancel' | 'reschedule';

/** "se cancela sin costo con al menos 24 horas de anticipación" (4.5, 4.6). */
export function describePolicy(action: ChangeAction, noticeHours: number): string {
  const verb = action === 'cancel' ? 'cancela' : 'reprograma';
  if (noticeHours === 0) return `se ${verb} sin costo hasta que empieza el turno`;
  const hours = noticeHours === 1 ? '1 hora' : `${String(noticeHours)} horas`;
  return `se ${verb} sin costo con al menos ${hours} de anticipación`;
}

/** Por qué no corresponde cancelar o reprogramar y cuál es la política: lo que se le explica a la clienta. */
export function describeChangeRefusal(input: {
  action: ChangeAction;
  reason: ChangeRefusal;
  freeCancellationNoticeHours: number;
  reschedulesKeepingDeposit: number;
}): { motivo: string; politica: string } {
  const { action, reason, freeCancellationNoticeHours: hours, reschedulesKeepingDeposit: allowed } = input;

  switch (reason) {
    case 'too_late': {
      const text = hours === 1 ? '1 hora' : `${String(hours)} horas`;
      return { motivo: `faltan menos de ${text} para el turno`, politica: describePolicy(action, hours) };
    }
    case 'already_started':
      return { motivo: 'el turno ya empezó', politica: describePolicy(action, hours) };
    case 'no_reschedules_left':
      return {
        motivo:
          allowed === 0
            ? 'con la seña paga no se puede reprogramar conservándola'
            : allowed === 1
              ? 'ya usaste la reprogramación que conserva la seña'
              : `ya usaste las ${String(allowed)} reprogramaciones que conservan la seña`,
        politica:
          allowed === 0
            ? 'este negocio no conserva la seña al reprogramar'
            : allowed === 1
              ? 'con la seña paga se puede reprogramar 1 vez conservando la seña'
              : `con la seña paga se puede reprogramar ${String(allowed)} veces conservando la seña`,
      };
  }
}
