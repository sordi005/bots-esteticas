import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { professionals, services } from '../../src/modules/catalog/schema.js';
import { conversations, handoffs } from '../../src/modules/conversation/schema.js';
import { customers } from '../../src/modules/customers/schema.js';
import { notifications, ownerReplies } from '../../src/modules/notifications/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import type { EvalState } from './evaluate.js';
import { formatLocalStart } from './local-time.js';

/**
 * Lo que las evaluaciones leen de la base después de la vuelta (`EvalState`) y la limpieza que
 * hacen al terminar cada caso. Los casos comparten la base y los horarios de Mica y Sofi, así
 * que lo que un caso crea en la agenda no puede quedar para el siguiente.
 */

export interface StateInput {
  tenantId: string;
  customerId: string;
  conversationId: string;
  /** Las clientas que preparó el caso además de la suya: sus turnos también figuran en el estado. */
  otherCustomerIds: string[];
  /** id del turno → clave con la que lo preparó el caso. */
  appointmentKeys: ReadonlyMap<string, string>;
  timeZone: string;
}

export async function readEvalState(db: NodePgDatabase, input: StateInput): Promise<EvalState> {
  const { tenantId, customerId, conversationId, otherCustomerIds, appointmentKeys, timeZone } = input;

  const appointmentRows = await db
    .select({
      id: appointments.id,
      customerId: appointments.customerId,
      status: appointments.status,
      timeRange: appointments.timeRange,
      serviceName: services.name,
      professionalName: professionals.name,
    })
    .from(appointments)
    .innerJoin(services, and(eq(services.tenantId, appointments.tenantId), eq(services.id, appointments.serviceId)))
    .innerJoin(
      professionals,
      and(eq(professionals.tenantId, appointments.tenantId), eq(professionals.id, appointments.professionalId)),
    )
    .where(and(eq(appointments.tenantId, tenantId), inArray(appointments.customerId, [customerId, ...otherCustomerIds])))
    .orderBy(asc(sql`lower(${appointments.timeRange})`), asc(appointments.id));

  // Los turnos en los que la clienta tocó «Confirmo» en el recordatorio (4.7, H10).
  const appointmentIds = appointmentRows.map((row) => row.id);
  const confirmed = new Set(
    appointmentIds.length === 0
      ? []
      : (
          await db
            .select({ appointmentId: appointmentEvents.appointmentId })
            .from(appointmentEvents)
            .where(
              and(
                eq(appointmentEvents.tenantId, tenantId),
                inArray(appointmentEvents.appointmentId, appointmentIds),
                eq(appointmentEvents.kind, 'attendance_confirmed'),
              ),
            )
        ).map((row) => row.appointmentId),
  );

  const handoffRows = await db
    .select({ motivo: handoffs.reason, resumen: handoffs.summary })
    .from(handoffs)
    .where(and(eq(handoffs.tenantId, tenantId), eq(handoffs.conversationId, conversationId)))
    .orderBy(asc(handoffs.createdAt), asc(handoffs.id));

  const [conversation] = await db
    .select({ status: conversations.assistantStatus })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
  const [customer] = await db
    .select({ name: customers.name })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
  if (!conversation || !customer) throw new Error('No se encontró la conversación o la clienta de la evaluación');

  return {
    turnos: appointmentRows.map((row) => ({
      clave: appointmentKeys.get(row.id) ?? null,
      de: row.customerId === customerId ? 'clienta' : 'otra',
      servicio: row.serviceName,
      profesional: row.professionalName,
      inicio: formatLocalStart(row.timeRange.start, timeZone),
      estado: row.status,
      asistenciaConfirmada: confirmed.has(row.id),
    })),
    derivaciones: handoffRows,
    pausada: conversation.status === 'paused',
    nombreClienta: customer.name,
  };
}

/**
 * Borra los turnos de esas clientas, con sus señas, sus eventos de auditoría y los avisos (limpieza de test:
 * en producción un turno no se borra). Los demás datos del caso (clientas, conversaciones,
 * mensajes) no pisan a nadie: cada caso usa clientas nuevas.
 */
export async function deleteAppointmentsOf(
  db: NodePgDatabase,
  input: { tenantId: string; customerIds: string[] },
): Promise<void> {
  const { tenantId, customerIds } = input;
  if (customerIds.length === 0) return;

  await db.transaction(async (tx) => {
    // Los avisos (H9) apuntan a los turnos: se borran primero, con los botones que tocó la dueña.
    const notices = tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), inArray(notifications.customerId, customerIds)));
    await tx.delete(ownerReplies).where(and(eq(ownerReplies.tenantId, tenantId), inArray(ownerReplies.notificationId, notices)));
    await tx
      .delete(notifications)
      .where(and(eq(notifications.tenantId, tenantId), inArray(notifications.customerId, customerIds)));

    const rows = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.tenantId, tenantId), inArray(appointments.customerId, customerIds)));
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return;

    await tx
      .delete(appointmentEvents)
      .where(and(eq(appointmentEvents.tenantId, tenantId), inArray(appointmentEvents.appointmentId, ids)));
    await tx.delete(deposits).where(and(eq(deposits.tenantId, tenantId), inArray(deposits.appointmentId, ids)));
    await tx.delete(appointments).where(and(eq(appointments.tenantId, tenantId), inArray(appointments.id, ids)));
  });
}
