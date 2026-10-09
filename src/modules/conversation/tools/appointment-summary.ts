import { eq } from 'drizzle-orm';
import type { Queryable } from '../../../shared/db.js';
import type { CustomerAppointment } from '../../scheduling/customer-appointments.js';
import { evaluateCustomerCancellation } from '../../scheduling/change-policy.js';
import { tenantSettings } from '../../tenants/schema.js';
import { formatLocalSlot, formatPesos } from '../format.js';
import {
  describeAppointmentStatus,
  describeDepositMethod,
  describeDepositStatus,
  formatDeadline,
} from './appointment-content.js';
import { choiceIds } from './choice-ids.js';

/**
 * Cómo se le cuenta un turno de la clienta al modelo: todo escrito por el código (6.4). Lo usan
 * las cuatro herramientas de turnos, así dicen lo mismo del mismo turno.
 */

const HOUR_MS = 60 * 60 * 1_000;

/** Lo que las herramientas de turnos leen de la configuración del negocio. */
export type AppointmentSettings = Pick<
  typeof tenantSettings.$inferSelect,
  'freeCancellationNoticeHours' | 'reschedulesKeepingDeposit' | 'depositPaymentOptions'
>;

export async function loadAppointmentSettings(db: Queryable, tenantId: string): Promise<AppointmentSettings> {
  const [settings] = await db
    .select({
      freeCancellationNoticeHours: tenantSettings.freeCancellationNoticeHours,
      reschedulesKeepingDeposit: tenantSettings.reschedulesKeepingDeposit,
      depositPaymentOptions: tenantSettings.depositPaymentOptions,
    })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  if (!settings) throw new Error('No se encontró la configuración del negocio');
  return settings;
}

export interface SummaryContext {
  now: Date;
  timeZone: string;
  settings: AppointmentSettings;
}

/** ¿La seña pendiente ya venció, aunque la tarea programada todavía no haya vencido el turno? */
export function isExpiredPending(appointment: CustomerAppointment, now: Date): boolean {
  return (
    appointment.status === 'PENDING_DEPOSIT' &&
    appointment.deposit !== null &&
    appointment.deposit.expiresAt.getTime() <= now.getTime()
  );
}

/** El estado en español. Una reserva con la seña vencida ya no está pendiente: se dice que venció. */
export function displayStatus(appointment: CustomerAppointment, now: Date): string {
  return describeAppointmentStatus(isExpiredPending(appointment, now) ? 'EXPIRED' : appointment.status);
}

/** La seña de un turno: el monto y su estado; si está pendiente, hasta cuándo pagarla y por qué medio. */
function describeDeposit(appointment: CustomerAppointment, ctx: SummaryContext): Record<string, unknown> | null {
  const { deposit } = appointment;
  if (!deposit) return null;
  const amount = formatPesos(deposit.amountCents);
  if (appointment.status === 'PENDING_DEPOSIT' && deposit.status === 'pending' && !isExpiredPending(appointment, ctx.now)) {
    return {
      monto: amount,
      estado: describeDepositStatus('pending'),
      pagarHasta: formatDeadline(deposit.expiresAt, ctx.now, ctx.timeZone),
      medio: describeDepositMethod(ctx.settings.depositPaymentOptions),
    };
  }
  return { monto: amount, estado: describeDepositStatus(deposit.status) };
}

/** El turno tal como lo ve el modelo. `turnoId` es el id para las demás herramientas. */
export function summarizeAppointment(appointment: CustomerAppointment, ctx: SummaryContext): Record<string, unknown> {
  const deposit = describeDeposit(appointment, ctx);
  return {
    turnoId: choiceIds.appointment(appointment.id),
    servicio: appointment.serviceName,
    profesional: appointment.professionalName,
    fecha: formatLocalSlot(appointment.start, ctx.timeZone),
    estado: displayStatus(appointment, ctx.now),
    ...(deposit ? { sena: deposit } : {}),
  };
}

/** Hasta cuándo se puede cancelar o reprogramar sin costo (4.6), o que ya está fuera de plazo. */
export function describeChangeDeadline(appointment: CustomerAppointment, ctx: SummaryContext): string {
  const decision = evaluateCustomerCancellation({
    appointmentStart: appointment.start,
    now: ctx.now,
    freeCancellationNoticeHours: ctx.settings.freeCancellationNoticeHours,
  });
  if (!decision.allowed) {
    return 'ya está fuera de plazo: cancelarlo o reprogramarlo lo ve una persona del equipo';
  }
  const deadline = new Date(appointment.start.getTime() - ctx.settings.freeCancellationNoticeHours * HOUR_MS);
  return `hasta ${formatDeadline(deadline, ctx.now, ctx.timeZone)}`;
}
