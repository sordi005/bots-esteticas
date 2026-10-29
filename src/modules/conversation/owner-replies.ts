import { and, desc, eq, ne } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Queryable } from '../../shared/db.js';
import type { JobHandler } from '../jobs/runner.js';
import { loadNoticeAppointment, loadNoticeCustomer } from '../notifications/notice-data.js';
import { enqueueNotification } from '../notifications/outbox.js';
import type { OwnerReplyAction } from '../notifications/owner-buttons.js';
import { notifications, ownerReplies } from '../notifications/schema.js';
import {
  customerDepositConfirmed,
  customerDepositConfirmedTemplate,
  customerDepositRejected,
  customerDepositRejectedTemplate,
  depositReviewAck,
  handoffAttendedAck,
} from '../notifications/texts.js';
import type { OutgoingMessage } from '../whatsapp/outgoing.js';
import { reviewDeposit } from '../scheduling/booking.js';
import { recordHandoff } from './handoff.js';
import { conversations, handoffs } from './schema.js';

/**
 * Lo que pasa cuando la dueña toca un botón de un aviso (4.5, 4.8). Lo ejecuta la tarea
 * `process_owner_reply` (regla 6). Cada cambio, sus avisos y la marca de procesado van en una
 * transacción; un botón se procesa una sola vez y solo si lo que decide sigue pendiente (regla 7).
 */

export interface OwnerReplyDependencies {
  db: NodePgDatabase;
  logger: Logger;
  now: () => Date;
}

export type OwnerReplyResult =
  | 'deposit_confirmed'
  | 'deposit_rejected'
  | 'handoff_resolved'
  /** Lo que decidía ya no estaba pendiente: no cambió nada y se le contó a la dueña. */
  | 'unchanged'
  | 'already_processed'
  | 'not_found';

/** [D] Lo que guarda la derivación cuando la dueña toca «No llegó» (4.5). */
export const DEPOSIT_REJECTED_HANDOFF_SUMMARY = 'La dueña marcó que la transferencia de la seña no llegó';

interface Reply {
  id: string;
  tenantId: string;
  action: OwnerReplyAction;
  processedAt: Date | null;
  notificationId: string;
  customerId: string;
  appointmentId: string | null;
  depositId: string | null;
  handoffId: string | null;
}

async function markProcessed(tx: Queryable, reply: Reply, now: Date): Promise<void> {
  await tx
    .update(ownerReplies)
    .set({ processedAt: now })
    .where(and(eq(ownerReplies.tenantId, reply.tenantId), eq(ownerReplies.id, reply.id)));
}

/** La respuesta a la dueña, que va por el mismo canal que el aviso. */
function enqueueAck(tx: Queryable, reply: Reply, message: OutgoingMessage, now: Date) {
  return enqueueNotification(tx, {
    tenantId: reply.tenantId,
    recipient: 'owner',
    kind: 'owner_reply_ack',
    customerId: reply.customerId,
    ...(reply.appointmentId ? { appointmentId: reply.appointmentId } : {}),
    message,
    now,
  });
}

/** La conversación de la clienta: existe si mandó el comprobante, pero no cuesta asegurarlo. */
async function conversationOf(tx: Queryable, tenantId: string, customerId: string): Promise<string> {
  await tx.insert(conversations).values({ tenantId, customerId }).onConflictDoNothing();
  const [conversation] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.customerId, customerId)));
  if (!conversation) throw new Error('No se encontró la conversación de la clienta');
  return conversation.id;
}

async function processDepositReply(deps: OwnerReplyDependencies, reply: Reply, now: Date): Promise<OwnerReplyResult> {
  const { db } = deps;
  const { tenantId } = reply;
  if (!reply.depositId || !reply.appointmentId) throw new Error('El aviso del comprobante no tiene la seña');
  const decision = reply.action === 'deposit_received' ? 'approved' : 'rejected';

  const result = await reviewDeposit(db, {
    tenantId,
    depositId: reply.depositId,
    decision,
    actor: 'owner',
    now,
    inTransaction: async (tx, review) => {
      const appointment = await loadNoticeAppointment(tx, { tenantId, appointmentId: review.appointmentId });
      const confirmed = review.status === 'CONFIRMED';
      await enqueueNotification(tx, {
        tenantId,
        recipient: 'customer',
        kind: confirmed ? 'deposit_confirmed' : 'deposit_rejected',
        customerId: review.customerId,
        appointmentId: review.appointmentId,
        message: confirmed ? customerDepositConfirmed(appointment) : customerDepositRejected(appointment),
        template: confirmed ? customerDepositConfirmedTemplate(appointment) : customerDepositRejectedTemplate(appointment),
        now,
      });
      if (!confirmed) {
        // El asistente no discute un pago: la conversación pasa a una persona, sin otro aviso (4.5).
        await recordHandoff(tx, {
          tenantId,
          conversationId: await conversationOf(tx, tenantId, review.customerId),
          reason: 'payment_issue',
          summary: DEPOSIT_REJECTED_HANDOFF_SUMMARY,
          now,
          notifyOwner: false,
        });
      }
      await enqueueAck(tx, reply, depositReviewAck({ appointment, outcome: review.status }), now);
      await markProcessed(tx, reply, now);
    },
  });

  if (result.ok) return result.status === 'CONFIRMED' ? 'deposit_confirmed' : 'deposit_rejected';
  if (result.reason !== 'not_in_review') {
    // La dueña siempre puede decidir sobre una seña, y el aviso es del negocio: no debería pasar.
    deps.logger.warn({ tenant_id: tenantId, reason: result.reason }, 'No se pudo procesar el botón de la dueña');
    await markProcessed(db, reply, now);
    return 'not_found';
  }

  const { status } = result;
  await db.transaction(async (tx) => {
    const appointment = await loadNoticeAppointment(tx, { tenantId, appointmentId: result.appointmentId });
    await enqueueAck(tx, reply, depositReviewAck({ appointment, outcome: 'unchanged', status }), now);
    await markProcessed(tx, reply, now);
  });
  return 'unchanged';
}

/**
 * «Ya la atendí» (4.8): resuelve la derivación y reanuda el asistente desde ahora. Si el asistente
 * ya se había reanudado, o hay una derivación más nueva abierta en esa conversación, solo la
 * resuelve.
 */
async function processHandoffReply(deps: OwnerReplyDependencies, reply: Reply, now: Date): Promise<OwnerReplyResult> {
  const { tenantId, handoffId } = reply;
  if (!handoffId) throw new Error('El aviso de la derivación no tiene la derivación');

  return deps.db.transaction(async (tx) => {
    const [handoff] = await tx
      .select({ status: handoffs.status, conversationId: handoffs.conversationId })
      .from(handoffs)
      .where(and(eq(handoffs.tenantId, tenantId), eq(handoffs.id, handoffId)))
      .for('update');
    if (!handoff) throw new Error('No se encontró la derivación del aviso');
    const customer = await loadNoticeCustomer(tx, { tenantId, customerId: reply.customerId });

    if (handoff.status === 'resolved') {
      await enqueueAck(tx, reply, handoffAttendedAck({ customerName: customer.customerName, outcome: 'already_resolved' }), now);
      await markProcessed(tx, reply, now);
      return 'unchanged' as const;
    }

    await tx
      .update(handoffs)
      .set({ status: 'resolved', resolvedAt: now })
      .where(and(eq(handoffs.tenantId, tenantId), eq(handoffs.id, handoffId)));

    const thisConversation = and(eq(conversations.tenantId, tenantId), eq(conversations.id, handoff.conversationId));
    const [conversation] = await tx
      .select({ assistantStatus: conversations.assistantStatus })
      .from(conversations)
      .where(thisConversation)
      .for('update');
    const [newerOpen] = await tx
      .select({ id: handoffs.id })
      .from(handoffs)
      .where(
        and(
          eq(handoffs.tenantId, tenantId),
          eq(handoffs.conversationId, handoff.conversationId),
          eq(handoffs.status, 'open'),
          ne(handoffs.id, handoffId),
        ),
      )
      .orderBy(desc(handoffs.createdAt))
      .limit(1);

    const resumes = conversation?.assistantStatus === 'paused' && !newerOpen;
    if (resumes) {
      // Como cuando vence la pausa (4.8): el historial que ve el modelo arranca acá.
      await tx
        .update(conversations)
        .set({ assistantStatus: 'active', pausedUntil: null, resumedAt: now })
        .where(thisConversation);
    }
    await enqueueAck(
      tx,
      reply,
      handoffAttendedAck({ customerName: customer.customerName, outcome: resumes ? 'resumed' : 'resolved' }),
      now,
    );
    await markProcessed(tx, reply, now);
    return 'handoff_resolved' as const;
  });
}

export async function processOwnerReply(
  deps: OwnerReplyDependencies,
  input: { tenantId: string; ownerReplyId: string },
): Promise<OwnerReplyResult> {
  const { tenantId, ownerReplyId } = input;
  const now = deps.now();

  const [reply] = await deps.db
    .select({
      id: ownerReplies.id,
      tenantId: ownerReplies.tenantId,
      action: ownerReplies.action,
      processedAt: ownerReplies.processedAt,
      notificationId: notifications.id,
      customerId: notifications.customerId,
      appointmentId: notifications.appointmentId,
      depositId: notifications.depositId,
      handoffId: notifications.handoffId,
    })
    .from(ownerReplies)
    .innerJoin(
      notifications,
      and(eq(notifications.tenantId, ownerReplies.tenantId), eq(notifications.id, ownerReplies.notificationId)),
    )
    .where(and(eq(ownerReplies.tenantId, tenantId), eq(ownerReplies.id, ownerReplyId)));
  if (!reply) return 'not_found';
  if (reply.processedAt) return 'already_processed';

  return reply.action === 'handoff_attended'
    ? processHandoffReply(deps, reply, now)
    : processDepositReply(deps, reply, now);
}

const processOwnerReplyPayload = z.object({ ownerReplyId: z.uuid() });

/** El handler de las tareas `process_owner_reply` para el worker. */
export function ownerReplyJobHandler(deps: OwnerReplyDependencies): JobHandler {
  return async (job, { signal }) => {
    const payload = processOwnerReplyPayload.safeParse(job.payload);
    if (!payload.success) {
      throw new Error(`Datos de la tarea inválidos: ${z.prettifyError(payload.error)}`);
    }
    signal.throwIfAborted();
    await processOwnerReply(deps, { tenantId: job.tenantId, ownerReplyId: payload.data.ownerReplyId });
  };
}
