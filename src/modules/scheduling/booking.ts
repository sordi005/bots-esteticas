import { and, count, eq, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { customers } from '../customers/schema.js';
import { depositAmountCents, resolveDepositRule } from '../payments/deposit-policy.js';
import { deposits } from '../payments/schema.js';
import type { Queryable } from '../../shared/db.js';
import { EXCLUSION_VIOLATION, isConstraintViolation } from '../../shared/postgres-errors.js';
import type { TimestampRange } from '../../shared/timestamp-range.js';
import {
  canReschedule,
  canTransition,
  rescheduleEvent,
  transition,
  type Actor,
  type AppointmentStatus,
} from './appointment-state-machine.js';
import {
  loadAvailabilityContext,
  overlaps,
  type AvailabilityContext,
} from './availability-context.js';
import { findAvailableSlots, type ProfessionalSchedule } from './availability.js';
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
  const offers = (busy: ProfessionalSchedule['busy']) =>
    findAvailableSlots({
      ...context.query,
      window: { start, end: new Date(start.getTime() + MINUTE_MS) },
      professionals: [{ ...professional, busy }],
    }).some((slot) => slot.start.getTime() === start.getTime());

  if (!offers([])) return 'slot_unavailable';
  if (!offers(professional.busy)) return 'slot_taken';
  return 'ok';
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
    await applyStatusChange(tx, {
      tenantId,
      appointmentId: id,
      from: 'PENDING_DEPOSIT',
      to: 'EXPIRED',
      actor: 'system',
      reason: 'Venció el plazo para pagar la seña',
      now,
    });
  }
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
    return await db.transaction(async (tx) => {
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

      if (depositCents === null) {
        return { ok: true, appointmentId: appointment.id, status, deposit: null } as const;
      }

      const expiresAt = new Date(now.getTime() + settings.depositPaymentWindowMinutes * MINUTE_MS);
      const [deposit] = await tx
        .insert(deposits)
        .values({ tenantId, appointmentId: appointment.id, amountCents: depositCents, expiresAt })
        .returning({ id: deposits.id });
      if (!deposit) throw new Error('La base no devolvió la seña creada');

      return {
        ok: true,
        appointmentId: appointment.id,
        status,
        deposit: { id: deposit.id, amountCents: depositCents, expiresAt },
      } as const;
    });
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

export async function changeAppointmentStatus(
  db: NodePgDatabase,
  input: {
    tenantId: string;
    appointmentId: string;
    to: AppointmentStatus;
    actor: Actor;
    reason?: string;
    now: Date;
  },
): Promise<StatusChangeResult> {
  const { tenantId, appointmentId, to, actor } = input;

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
      ...input,
      from: current.status,
      customerId: current.customerId,
    });
    return { ok: true } as const;
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
  },
): Promise<RescheduleResult> {
  const { tenantId, appointmentId, newStart, actor, reason, now } = input;
  const thisAppointment = and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId));

  const [current] = await db.select().from(appointments).where(thisAppointment);
  if (!current) return { ok: false, reason: 'not_found' };
  if (!canReschedule(current.status, actor)) return { ok: false, reason: 'not_reschedulable' };

  const context = await loadAvailabilityContext(db, {
    tenantId,
    serviceId: current.serviceId,
    professionalIds: [current.professionalId],
    window: { start: newStart, end: new Date(newStart.getTime() + MINUTE_MS) },
    now,
    excludeAppointmentId: appointmentId,
  });
  const professional = context?.query.professionals.find((p) => p.id === current.professionalId);
  if (!context || !professional) return { ok: false, reason: 'slot_unavailable' };

  // La duración y el margen son los del momento de reservar, no los actuales del servicio.
  const snapshot: AvailabilityContext = {
    ...context,
    query: {
      ...context.query,
      service: { durationMinutes: current.durationMinutes, bufferMinutes: current.bufferMinutes },
    },
  };
  const slot = checkSlot(snapshot, { ...professional, durationOverrideMinutes: null }, newStart);
  if (slot !== 'ok') return { ok: false, reason: slot };

  const newRange = occupiedRange(newStart, current.durationMinutes, current.bufferMinutes);

  try {
    return await db.transaction(async (tx) => {
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
      return { ok: true } as const;
    });
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
