import { and, count, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { customers } from '../customers/schema.js';
import { depositAmountCents, resolveDepositRule } from '../payments/deposit-policy.js';
import { deposits } from '../payments/schema.js';
import type { Queryable } from '../../shared/db.js';
import { EXCLUSION_VIOLATION, isConstraintViolation, retryOnDeadlock } from '../../shared/postgres-errors.js';
import type { TimestampRange } from '../../shared/timestamp-range.js';
import {
  attendanceConfirmedEvent,
  canReschedule,
  canTransition,
  receivesReminder,
  rescheduleEvent,
  transition,
  type Actor,
  type AppointmentStatus,
} from './appointment-state-machine.js';
import { scheduleReminders, scheduleReservationExpiry } from './appointment-jobs.js';
import {
  loadAvailabilityContext,
  loadRescheduleContext,
  overlaps,
  type AvailabilityContext,
} from './availability-context.js';
import { diagnoseStart, holdsSchedule, type ProfessionalSchedule } from './availability.js';
import { appointmentEvents, appointments } from './schema.js';

/**
 * Reservas, cambios de estado y reprogramaciones (secciones 4.4 a 4.6, 6.6).
 *
 * "La IA elige, el código decide" (regla 2): el asistente propone un horario y acá se
 * verifica todo contra la base antes de guardar. Si dos clientas eligen el mismo horario a
 * la vez, lo decide la restricción `appointments_no_overlap`: gana una sola.
 * Cada cambio registra su evento de auditoría en la misma transacción (regla 4).
 */

const MINUTE_MS = 60_000;
const NO_OVERLAP = 'appointments_no_overlap';

/**
 * Lo que el que llama quiere hacer en la misma transacción que el cambio, por ejemplo guardar el
 * aviso a la dueña (6.7): si falla, el cambio tampoco queda. El dominio no sabe qué es un aviso.
 */
export type InTransaction<T> = (tx: Queryable, change: T) => Promise<void>;

export type SlotCheck = 'ok' | 'slot_unavailable' | 'slot_taken';

/**
 * `slot_unavailable`: el horario no es un turno válido (fuera de horario, fuera de la
 * grilla, sin la anticipación). `slot_taken`: sería válido, pero ya está ocupado.
 */
export function checkSlot(
  context: AvailabilityContext,
  professional: ProfessionalSchedule,
  start: Date,
): SlotCheck {
  const { kind } = diagnoseStart(context.query, professional, start);
  if (kind === 'free') return 'ok';
  return kind === 'taken' ? 'slot_taken' : 'slot_unavailable';
}

function occupiedRange(start: Date, durationMinutes: number, bufferMinutes: number): TimestampRange {
  return {
    start,
    end: new Date(start.getTime() + (durationMinutes + bufferMinutes) * MINUTE_MS),
  };
}

/**
 * Vence las reservas provisorias de esa profesional que se superponen con `range` y cuya
 * seña ya venció, aunque la tarea programada todavía no las haya vencido (sección 4.3).
 */
async function expireOverdueReservations(
  tx: Queryable,
  input: { tenantId: string; professionalId: string; range: TimestampRange; now: Date },
): Promise<void> {
  const { tenantId, professionalId, range, now } = input;
  const overdue = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .innerJoin(
      deposits,
      and(eq(deposits.tenantId, appointments.tenantId), eq(deposits.appointmentId, appointments.id)),
    )
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        eq(appointments.professionalId, professionalId),
        eq(appointments.status, 'PENDING_DEPOSIT'),
        lte(deposits.expiresAt, now),
        overlaps(appointments.timeRange, range),
      ),
    )
    .for('update', { of: appointments });

  for (const { id } of overdue) {
    await expireLocked(tx, { tenantId, appointmentId: id, now });
  }
}

/**
 * Vence un turno pendiente de seña ya bloqueado (4.5): lo usan la reserva que pisa su horario y la
 * tarea de vencimiento. El turno pasa a `EXPIRED` y la seña pendiente, a vencida.
 */
async function expireLocked(tx: Queryable, input: { tenantId: string; appointmentId: string; now: Date }) {
  await applyStatusChange(tx, {
    ...input,
    from: 'PENDING_DEPOSIT',
    to: 'EXPIRED',
    actor: 'system',
    reason: 'Venció el plazo para pagar la seña',
  });
}

/** Cambia el estado y guarda el evento, más lo que cada estado implica. Dentro de `tx`. */
async function applyStatusChange(
  tx: Queryable,
  input: {
    tenantId: string;
    appointmentId: string;
    from: AppointmentStatus;
    to: AppointmentStatus;
    actor: Actor;
    reason?: string;
    now: Date;
    customerId?: string;
  },
): Promise<void> {
  const { tenantId, appointmentId, from, to, actor, reason, now } = input;
  const event = transition({ from, to, actor, ...(reason ? { reason } : {}), at: now });
  const thisAppointment = and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId));

  await tx.update(appointments).set({ status: to }).where(thisAppointment);
  await tx.insert(appointmentEvents).values({ tenantId, appointmentId, ...event });

  if (to === 'EXPIRED') {
    await tx
      .update(deposits)
      .set({ status: 'expired' })
      .where(
        and(
          eq(deposits.tenantId, tenantId),
          eq(deposits.appointmentId, appointmentId),
          eq(deposits.status, 'pending'),
        ),
      );
  }
  if (to === 'NO_SHOW' && input.customerId) {
    // La regla de seña "solo clientas con ausencias previas" usa este contador.
    await tx
      .update(customers)
      .set({ noShowCount: sql`${customers.noShowCount} + 1` })
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, input.customerId)));
  }
}

// ─── Reservar ──────────────────────────────────────────────────────────────────

export type BookingRefusal =
  | 'not_found'
  | 'service_not_bookable'
  | 'professional_unavailable'
  | 'slot_unavailable'
  | 'slot_taken';

export type BookingResult =
  | {
      ok: true;
      appointmentId: string;
      status: 'PENDING_DEPOSIT' | 'CONFIRMED';
      deposit: { id: string; amountCents: number; expiresAt: Date } | null;
    }
  | { ok: false; reason: BookingRefusal };

export async function bookAppointment(
  db: NodePgDatabase,
  input: {
    tenantId: string;
    customerId: string;
    serviceId: string;
    professionalId: string;
    start: Date;
    actor: Actor;
    now: Date;
  },
): Promise<BookingResult> {
  const { tenantId, customerId, serviceId, professionalId, start, actor, now } = input;

  const [customer] = await db
    .select({ noShowCount: customers.noShowCount })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
  const context = await loadAvailabilityContext(db, {
    tenantId,
    serviceId,
    professionalIds: [professionalId],
    window: { start, end: new Date(start.getTime() + MINUTE_MS) },
    now,
  });
  if (!customer || !context) return { ok: false, reason: 'not_found' };

  const { service, settings } = context;
  // El asistente no agenda lo que requiere consulta previa ni lo que no ofrece (4.1): deriva.
  if (actor === 'assistant' && (!service.visible || service.requiresConsultation)) {
    return { ok: false, reason: 'service_not_bookable' };
  }

  const professional = context.query.professionals.find((p) => p.id === professionalId);
  if (!professional) return { ok: false, reason: 'professional_unavailable' };

  const slot = checkSlot(context, professional, start);
  if (slot !== 'ok') return { ok: false, reason: slot };

  const [history] = await db
    .select({ completed: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        eq(appointments.customerId, customerId),
        eq(appointments.status, 'COMPLETED'),
      ),
    );
  const depositCents = depositAmountCents({
    rule: resolveDepositRule(
      {
        requirement: settings.depositRequirement,
        percentage: settings.depositPercentage,
        fixedAmountCents: settings.depositFixedAmountCents,
      },
      {
        requirement: service.depositRequirement,
        percentage: service.depositPercentage,
        fixedAmountCents: service.depositFixedAmountCents,
      },
    ),
    priceCents: service.priceCents,
    customer: { completedAppointments: history?.completed ?? 0, noShowCount: customer.noShowCount },
  });

  const status = depositCents === null ? 'CONFIRMED' : 'PENDING_DEPOSIT';
  const creation = transition({ from: null, to: status, actor, at: now });
  const durationMinutes = professional.durationOverrideMinutes ?? service.durationMinutes;
  const timeRange = occupiedRange(start, durationMinutes, service.bufferMinutes);

  try {
    // Dos guardados a la vez del mismo horario pueden terminar en un deadlock en vez de en la
    // violación de la restricción: se reintenta una vez y ahí la que perdió recibe la violación (6.6).
    return await retryOnDeadlock(() => db.transaction(async (tx) => {
      await expireOverdueReservations(tx, { tenantId, professionalId, range: timeRange, now });

      const [appointment] = await tx
        .insert(appointments)
        .values({
          tenantId,
          customerId,
          serviceId,
          professionalId,
          timeRange,
          durationMinutes,
          bufferMinutes: service.bufferMinutes,
          priceCents: service.priceCents,
          cashPriceCents: service.cashPriceCents,
          priceType: service.priceType,
          status,
          origin: actor,
        })
        .returning({ id: appointments.id });
      if (!appointment) throw new Error('La base no devolvió el turno creado');

      await tx.insert(appointmentEvents).values({ tenantId, appointmentId: appointment.id, ...creation });
      // Los recordatorios y el vencimiento quedan programados con la reserva (4.5, 4.7).
      await scheduleReminders(tx, {
        tenantId,
        appointmentId: appointment.id,
        start,
        bookedAt: now,
        timeZone: context.query.timeZone,
        settings,
      });

      if (depositCents === null) {
        return { ok: true, appointmentId: appointment.id, status, deposit: null } as const;
      }

      const expiresAt = new Date(now.getTime() + settings.depositPaymentWindowMinutes * MINUTE_MS);
      const [deposit] = await tx
        .insert(deposits)
        // El medio es el que tiene el negocio al reservar, como el precio (4.5, decisión 23).
        .values({
          tenantId,
          appointmentId: appointment.id,
          amountCents: depositCents,
          method: settings.depositPaymentOptions,
          expiresAt,
        })
        .returning({ id: deposits.id });
      if (!deposit) throw new Error('La base no devolvió la seña creada');
      await scheduleReservationExpiry(tx, { tenantId, appointmentId: appointment.id, expiresAt });

      return {
        ok: true,
        appointmentId: appointment.id,
        status,
        deposit: { id: deposit.id, amountCents: depositCents, expiresAt },
      } as const;
    }));
  } catch (error) {
    // Otra clienta ganó el horario entre la verificación y el guardado (sección 6.6).
    if (isConstraintViolation(error, EXCLUSION_VIOLATION, NO_OVERLAP)) {
      return { ok: false, reason: 'slot_taken' };
    }
    throw error;
  }
}

// ─── Cambiar el estado ─────────────────────────────────────────────────────────

export type StatusChangeResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'invalid_transition' };

export interface StatusChange {
  appointmentId: string;
  from: AppointmentStatus;
  to: AppointmentStatus;
}

export async function changeAppointmentStatus(
  db: NodePgDatabase,
  input: {
    tenantId: string;
    appointmentId: string;
    to: AppointmentStatus;
    actor: Actor;
    reason?: string;
    now: Date;
    inTransaction?: InTransaction<StatusChange>;
  },
): Promise<StatusChangeResult> {
  const { tenantId, appointmentId, to, actor, inTransaction } = input;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: appointments.status, customerId: appointments.customerId })
      .from(appointments)
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId)))
      .for('update');
    if (!current) return { ok: false, reason: 'not_found' } as const;
    if (!canTransition(current.status, to, actor)) {
      return { ok: false, reason: 'invalid_transition' } as const;
    }

    await applyStatusChange(tx, {
      tenantId,
      appointmentId,
      to,
      actor,
      ...(input.reason ? { reason: input.reason } : {}),
      now: input.now,
      from: current.status,
      customerId: current.customerId,
    });
    await inTransaction?.(tx, { appointmentId, from: current.status, to });
    return { ok: true } as const;
  });
}

// ─── Vencer y confirmar asistencia (H10) ───────────────────────────────────────

export type ExpiryResult =
  | { ok: true; outcome: 'expired' | 'already_expired' }
  | { ok: false; reason: 'not_found' | 'not_due' }
  | { ok: false; reason: 'not_pending'; status: AppointmentStatus };

/**
 * La tarea de vencimiento (4.5): con el turno bloqueado, lo vence si sigue pendiente de seña y el
 * plazo pasó. Uno en verificación nunca vence (4.4). Si ya estaba vencido (lo venció una reserva que
 * pisaba su horario) también llama a `inTransaction`: el aviso a la clienta sale venza por donde venza.
 */
export async function expireReservation(
  db: NodePgDatabase,
  input: {
    tenantId: string;
    appointmentId: string;
    now: Date;
    inTransaction?: InTransaction<{ appointmentId: string; start: Date }>;
  },
): Promise<ExpiryResult> {
  const { tenantId, appointmentId, now, inTransaction } = input;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: appointments.status, timeRange: appointments.timeRange, expiresAt: deposits.expiresAt })
      .from(appointments)
      .leftJoin(deposits, and(eq(deposits.tenantId, appointments.tenantId), eq(deposits.appointmentId, appointments.id)))
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId)))
      .for('update', { of: appointments });
    if (!current) return { ok: false, reason: 'not_found' } as const;
    const change = { appointmentId, start: current.timeRange.start };

    if (current.status === 'EXPIRED') {
      await inTransaction?.(tx, change);
      return { ok: true, outcome: 'already_expired' } as const;
    }
    if (current.status !== 'PENDING_DEPOSIT') {
      return { ok: false, reason: 'not_pending', status: current.status } as const;
    }
    // La misma regla que usa la disponibilidad para dejar de contarlo como ocupado (4.3).
    if (holdsSchedule({ status: current.status, depositExpiresAt: current.expiresAt }, now)) {
      return { ok: false, reason: 'not_due' } as const;
    }

    await expireLocked(tx, { tenantId, appointmentId, now });
    await inTransaction?.(tx, change);
    return { ok: true, outcome: 'expired' } as const;
  });
}

export type AttendanceResult =
  | { ok: true; alreadyConfirmed: boolean }
  | { ok: false; reason: 'not_found' | 'already_started' }
  | { ok: false; reason: 'not_confirmable'; status: AppointmentStatus };

/**
 * La clienta tocó «Confirmo» en el recordatorio (4.7): queda un evento de auditoría, sin cambiar el
 * estado. Una confirmación anterior a la última reprogramación no cuenta: era para otro horario.
 */
export async function confirmAttendance(
  db: NodePgDatabase,
  input: { tenantId: string; appointmentId: string; now: Date },
): Promise<AttendanceResult> {
  const { tenantId, appointmentId, now } = input;
  const ofThisAppointment = and(eq(appointmentEvents.tenantId, tenantId), eq(appointmentEvents.appointmentId, appointmentId));

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: appointments.status, timeRange: appointments.timeRange })
      .from(appointments)
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId)))
      .for('update');
    if (!current) return { ok: false, reason: 'not_found' } as const;
    if (!receivesReminder(current.status)) {
      return { ok: false, reason: 'not_confirmable', status: current.status } as const;
    }
    if (current.timeRange.start.getTime() <= now.getTime()) return { ok: false, reason: 'already_started' } as const;

    const [latest] = await tx
      .select({ kind: appointmentEvents.kind })
      .from(appointmentEvents)
      .where(and(ofThisAppointment, inArray(appointmentEvents.kind, ['attendance_confirmed', 'rescheduled'])))
      .orderBy(desc(appointmentEvents.occurredAt))
      .limit(1);
    if (latest?.kind === 'attendance_confirmed') return { ok: true, alreadyConfirmed: true } as const;

    await tx
      .insert(appointmentEvents)
      .values({ tenantId, appointmentId, ...attendanceConfirmedEvent({ status: current.status, at: now }) });
    return { ok: true, alreadyConfirmed: false } as const;
  });
}

// ─── Seña por transferencia ────────────────────────────────────────────────────

/** La seña con su turno, bloqueados para decidir sobre ellos (dentro de `tx`). */
async function lockDeposit(tx: Queryable, input: { tenantId: string; depositId: string }) {
  const [row] = await tx
    .select({
      appointmentId: appointments.id,
      appointmentStatus: appointments.status,
      customerId: appointments.customerId,
      depositStatus: deposits.status,
      receiptMediaId: deposits.receiptMediaId,
    })
    .from(deposits)
    .innerJoin(
      appointments,
      and(eq(appointments.tenantId, deposits.tenantId), eq(appointments.id, deposits.appointmentId)),
    )
    .where(and(eq(deposits.tenantId, input.tenantId), eq(deposits.id, input.depositId)))
    .for('update');
  return row;
}

export type ReceiptResult =
  | { ok: true; appointmentId: string; alreadyRegistered: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_pending'; status: AppointmentStatus };

/**
 * Llegó la foto del comprobante de una transferencia (4.5): el turno pasa a verificación y deja
 * de vencer. Antes se verifica, con el turno bloqueado, que siga pendiente de seña: cancelar no
 * cambia la seña, así que se mira el turno. Se acepta pasado el plazo mientras no haya vencido.
 *
 * La misma imagen otra vez (un reintento de la vuelta) devuelve `alreadyRegistered` sin tocar nada.
 */
export async function submitTransferReceipt(
  db: NodePgDatabase,
  input: {
    tenantId: string;
    depositId: string;
    /** Id de la imagen en WhatsApp. */
    mediaId: string;
    now: Date;
    inTransaction?: InTransaction<{ appointmentId: string }>;
  },
): Promise<ReceiptResult> {
  const { tenantId, depositId, mediaId, now, inTransaction } = input;

  return db.transaction(async (tx) => {
    const current = await lockDeposit(tx, { tenantId, depositId });
    if (!current) return { ok: false, reason: 'not_found' } as const;
    const { appointmentId } = current;

    if (current.receiptMediaId === mediaId) {
      return { ok: true, appointmentId, alreadyRegistered: true } as const;
    }
    if (current.appointmentStatus !== 'PENDING_DEPOSIT' || current.depositStatus !== 'pending') {
      return { ok: false, reason: 'not_pending', status: current.appointmentStatus } as const;
    }

    await applyStatusChange(tx, {
      tenantId,
      appointmentId,
      from: 'PENDING_DEPOSIT',
      to: 'DEPOSIT_REVIEW',
      actor: 'assistant',
      reason: 'Llegó el comprobante de la transferencia',
      now,
    });
    await tx
      .update(deposits)
      .set({ status: 'in_review', receiptMediaId: mediaId })
      .where(and(eq(deposits.tenantId, tenantId), eq(deposits.id, depositId)));
    await inTransaction?.(tx, { appointmentId });
    return { ok: true, appointmentId, alreadyRegistered: false } as const;
  });
}

export type DepositDecision = 'approved' | 'rejected';

export interface DepositReview {
  appointmentId: string;
  customerId: string;
  status: 'CONFIRMED' | 'DEPOSIT_REJECTED';
}

export type DepositReviewResult =
  | { ok: true; appointmentId: string; status: DepositReview['status'] }
  | { ok: false; reason: 'not_found' | 'not_allowed' }
  | { ok: false; reason: 'not_in_review'; appointmentId: string; status: AppointmentStatus };

/**
 * La dueña responde el aviso del comprobante (4.5): "Recibida" confirma el turno, "No llegó" lo
 * rechaza y libera el horario. Una transferencia la confirma siempre una persona, nunca el
 * asistente (4.4). Si el turno ya no está en verificación (ya respondió, o la clienta canceló),
 * no cambia nada y devuelve el estado actual para contárselo.
 */
export async function reviewDeposit(
  db: NodePgDatabase,
  input: {
    tenantId: string;
    depositId: string;
    decision: DepositDecision;
    actor: Actor;
    now: Date;
    inTransaction?: InTransaction<DepositReview>;
  },
): Promise<DepositReviewResult> {
  const { tenantId, depositId, decision, actor, now, inTransaction } = input;
  const to = decision === 'approved' ? 'CONFIRMED' : 'DEPOSIT_REJECTED';
  if (!canTransition('DEPOSIT_REVIEW', to, actor)) return { ok: false, reason: 'not_allowed' };

  return db.transaction(async (tx) => {
    const current = await lockDeposit(tx, { tenantId, depositId });
    if (!current) return { ok: false, reason: 'not_found' } as const;
    const { appointmentId, customerId } = current;

    if (current.appointmentStatus !== 'DEPOSIT_REVIEW' || current.depositStatus !== 'in_review') {
      return { ok: false, reason: 'not_in_review', appointmentId, status: current.appointmentStatus } as const;
    }

    await applyStatusChange(tx, {
      tenantId,
      appointmentId,
      from: 'DEPOSIT_REVIEW',
      to,
      actor,
      reason: decision === 'approved' ? 'La transferencia llegó' : 'La transferencia no llegó',
      now,
    });
    await tx
      .update(deposits)
      .set({ status: decision })
      .where(and(eq(deposits.tenantId, tenantId), eq(deposits.id, depositId)));
    await inTransaction?.(tx, { appointmentId, customerId, status: to });
    return { ok: true, appointmentId, status: to } as const;
  });
}

// ─── Reprogramar ───────────────────────────────────────────────────────────────

export type RescheduleResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_reschedulable' | 'slot_unavailable' | 'slot_taken' };

/**
 * Mueve un turno a otro horario libre de la misma profesional, con la duración y el margen
 * que tenía al reservarse. No cambia el estado: registra un evento `rescheduled`.
 * Si le corresponde o no a la clienta (plazo, reprogramaciones restantes) lo decide
 * `change-policy.ts` antes de llamar a esta función.
 */
export async function rescheduleAppointment(
  db: NodePgDatabase,
  input: {
    tenantId: string;
    appointmentId: string;
    newStart: Date;
    actor: Actor;
    reason?: string;
    now: Date;
    inTransaction?: InTransaction<{ appointmentId: string; previousStart: Date; newStart: Date }>;
  },
): Promise<RescheduleResult> {
  const { tenantId, appointmentId, newStart, actor, reason, now, inTransaction } = input;
  const thisAppointment = and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId));

  const [current] = await db.select().from(appointments).where(thisAppointment);
  if (!current) return { ok: false, reason: 'not_found' };
  if (!canReschedule(current.status, actor)) return { ok: false, reason: 'not_reschedulable' };

  // La duración y el margen son los del momento de reservar, no los actuales del servicio.
  const context = await loadRescheduleContext(db, {
    tenantId,
    appointment: current,
    window: { start: newStart, end: new Date(newStart.getTime() + MINUTE_MS) },
    now,
  });
  const professional = context?.query.professionals.find((p) => p.id === current.professionalId);
  if (!context || !professional) return { ok: false, reason: 'slot_unavailable' };

  const slot = checkSlot(context, professional, newStart);
  if (slot !== 'ok') return { ok: false, reason: slot };

  const newRange = occupiedRange(newStart, current.durationMinutes, current.bufferMinutes);

  try {
    // Dos guardados a la vez del mismo horario pueden terminar en un deadlock en vez de en la
    // violación de la restricción: se reintenta una vez y ahí la que perdió recibe la violación (6.6).
    return await retryOnDeadlock(() => db.transaction(async (tx) => {
      await expireOverdueReservations(tx, {
        tenantId,
        professionalId: current.professionalId,
        range: newRange,
        now,
      });

      const [locked] = await tx
        .select({ status: appointments.status, timeRange: appointments.timeRange })
        .from(appointments)
        .where(thisAppointment)
        .for('update');
      if (!locked || !canReschedule(locked.status, actor)) {
        return { ok: false, reason: 'not_reschedulable' } as const;
      }

      const event = rescheduleEvent({
        status: locked.status,
        previousTimeRange: locked.timeRange,
        actor,
        ...(reason ? { reason } : {}),
        at: now,
      });
      await tx.update(appointments).set({ timeRange: newRange }).where(thisAppointment);
      await tx.insert(appointmentEvents).values({ tenantId, appointmentId, ...event });
      // Para los recordatorios, el turno se reservó ahora: la clienta acaba de elegir el horario (4.7).
      await scheduleReminders(tx, {
        tenantId,
        appointmentId,
        start: newStart,
        bookedAt: now,
        timeZone: context.query.timeZone,
        settings: context.settings,
      });
      await inTransaction?.(tx, { appointmentId, previousStart: locked.timeRange.start, newStart });
      return { ok: true } as const;
    }));
  } catch (error) {
    if (isConstraintViolation(error, EXCLUSION_VIOLATION, NO_OVERLAP)) {
      return { ok: false, reason: 'slot_taken' };
    }
    throw error;
  }
}

/** Cuántas veces se reprogramó un turno: lo usa la política de seña (sección 4.5). */
export async function countReschedules(
  db: Queryable,
  input: { tenantId: string; appointmentId: string },
): Promise<number> {
  const [result] = await db
    .select({ total: count() })
    .from(appointmentEvents)
    .where(
      and(
        eq(appointmentEvents.tenantId, input.tenantId),
        eq(appointmentEvents.appointmentId, input.appointmentId),
        eq(appointmentEvents.kind, 'rescheduled'),
      ),
    );
  return result?.total ?? 0;
}
