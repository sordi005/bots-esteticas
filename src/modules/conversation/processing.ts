import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Queryable } from '../../shared/db.js';
import { scheduleJob } from '../jobs/queue.js';
import type { JobHandler } from '../jobs/runner.js';
import { tenants } from '../tenants/schema.js';
import type { WhatsAppClient } from '../whatsapp/client.js';
import { freeFormMessageSchema, type FreeFormMessage } from '../whatsapp/outgoing.js';
import { registerReceiptWhilePaused } from './deposit-receipts.js';
import { registerReminderConfirmations } from './reminder-confirmations.js';
import { sendWhatsAppMessage } from './outbox.js';
import { conversations, messages } from './schema.js';

/**
 * Procesar una conversación (secciones 5.2, 6.5 y 6.7): el worker junta los mensajes
 * que la clienta mandó seguidos y contesta una sola vez.
 */

/**
 * [S] Una respuesta guardada que no se pudo enviar en 5 minutos se descarta (6.7): los reintentos
 * son a los 30 segundos y a los 2 minutos, y más tarde ya no tiene sentido.
 */
export const PENDING_REPLY_MAX_AGE_MS = 5 * 60 * 1_000;

/** [D] Valor inicial del agrupado: se contesta 4 segundos después del último mensaje (5.2). */
export const MESSAGE_GROUPING_DELAY_MS = 4_000;

export interface ReceivedMessage {
  id: string;
  /** Tipo según WhatsApp: text, interactive, image, audio… */
  type: string;
  /** El mensaje tal como lo mandó Meta. */
  content: Record<string, unknown>;
  occurredAt: Date;
}

/** Una vuelta: los mensajes nuevos de la clienta, del más viejo al más nuevo. */
export interface ConversationTurn {
  tenantId: string;
  conversationId: string;
  customerId: string;
  messages: ReceivedMessage[];
}

/**
 * Arma la respuesta a una vuelta: un solo mensaje (5.1, principio 4), o null para no
 * contestar. Desde H7 lo arma el agente (`agent/agent-responder.ts`).
 */
export type Responder = (
  turn: ConversationTurn,
  context: { signal: AbortSignal },
) => Promise<FreeFormMessage | null>;

export interface ConversationDependencies {
  db: NodePgDatabase;
  logger: Logger;
  client: WhatsAppClient;
  credentialsKey: Buffer;
  respond: Responder;
  now: () => Date;
}

export type ProcessResult =
  | 'not_found'
  | 'nothing_new'
  | 'replied'
  | 'no_reply'
  /** El asistente está pausado (derivación): los mensajes se marcaron procesados sin contestar (4.8). */
  | 'paused'
  /** El negocio no está activo: los mensajes se marcaron procesados sin contestar (6.7). */
  | 'tenant_inactive';

/**
 * Programa la vuelta de la conversación para dentro del tiempo de agrupado. Se llama en
 * la misma transacción que guarda el mensaje: si se guardó, quedó programado.
 */
export async function scheduleConversation(
  db: Queryable,
  input: { tenantId: string; conversationId: string; receivedAt: Date },
): Promise<void> {
  await scheduleJob(db, {
    tenantId: input.tenantId,
    kind: 'process_conversation',
    key: input.conversationId,
    payload: { conversationId: input.conversationId },
    runAt: new Date(input.receivedAt.getTime() + MESSAGE_GROUPING_DELAY_MS),
  });
}

/** Lo que hace falta para enviar una respuesta de esta conversación. */
interface ReplyTarget {
  tenantId: string;
  conversationId: string;
  customerId: string;
  logger: Logger;
}

/** Envía la respuesta guardada y la borra. Si el envío falla, el error sube y la respuesta queda guardada. */
async function deliverPendingReply(
  deps: ConversationDependencies,
  target: ReplyTarget,
  reply: { message: FreeFormMessage; savedAt: Date },
  signal: AbortSignal,
): Promise<void> {
  // Si ya venció el tiempo de la tarea, mejor no mandar nada: cuenta como fallo y se reintenta.
  signal.throwIfAborted();
  const { db } = deps;
  const { tenantId, customerId } = target;

  const result = await sendWhatsAppMessage(
    { db, client: deps.client, credentialsKey: deps.credentialsKey, now: deps.now() },
    { tenantId, customerId, message: reply.message },
  );
  if (!result.ok) {
    throw new Error(`No se pudo contestar la conversación: ${result.reason}`);
  }
  await clearPendingReply(db, target, reply.savedAt);
}

/**
 * Borra la respuesta guardada, solo si sigue siendo la misma (la fecha coincide): si mientras
 * tanto se guardó otra, no se pierde. Si falla el borrado después de enviar, el reintento puede
 * repetir la respuesta: es preferible contestar dos veces a no contestar (6.7).
 */
async function clearPendingReply(db: Queryable, target: ReplyTarget, savedAt: Date): Promise<void> {
  await db
    .update(conversations)
    .set({ pendingReply: null, pendingReplyAt: null })
    .where(
      and(
        eq(conversations.tenantId, target.tenantId),
        eq(conversations.id, target.conversationId),
        eq(conversations.pendingReplyAt, savedAt),
      ),
    );
}

/**
 * Si quedó una respuesta guardada de una vuelta anterior, la envía (o la descarta si es vieja).
 * Devuelve si se envió. Se envía aunque la conversación esté pausada: puede ser el mensaje de la
 * derivación (4.8).
 */
async function sendLeftoverReply(
  deps: ConversationDependencies,
  target: ReplyTarget,
  leftover: { reply: unknown; savedAt: Date | null },
  signal: AbortSignal,
): Promise<boolean> {
  const { savedAt } = leftover;
  if (leftover.reply === null || savedAt === null) return false;

  const ageMs = deps.now().getTime() - savedAt.getTime();
  const message = freeFormMessageSchema.safeParse(leftover.reply);
  if (ageMs > PENDING_REPLY_MAX_AGE_MS || !message.success) {
    // Solo la edad: el contenido de la respuesta no va al log (10.1).
    target.logger.warn(
      { ageMs, valid: message.success },
      'Se descartó una respuesta guardada que no se pudo enviar a tiempo',
    );
    await clearPendingReply(deps.db, target, savedAt);
    return false;
  }

  await deliverPendingReply(deps, target, { message: message.data, savedAt }, signal);
  return true;
}

/**
 * Procesa una conversación (6.7), en este orden:
 *
 * 1. Si quedó una respuesta guardada, la envía (o la descarta si es vieja). Si el envío falla, el
 *    error sube y NO se llama al modelo: volver a correr el agente daría otra respuesta (y las
 *    herramientas ya cambiaron cosas).
 * 2. Toma los mensajes entrantes sin procesar. Si no hay, termina.
 * 3. Negocio que no está activo, o asistente pausado por una derivación: los marca como
 *    procesados sin contestar ni llamar al modelo.
 * 4. Pide la respuesta, la guarda junto con la marca de procesados (una transacción), la envía y
 *    la borra.
 *
 * Si el envío sale pero falla borrar la respuesta guardada, el reintento puede repetirla: es
 * preferible contestar dos veces a no contestar.
 */
export async function processConversation(
  deps: ConversationDependencies,
  input: { tenantId: string; conversationId: string; signal: AbortSignal },
): Promise<ProcessResult> {
  const { db } = deps;
  const { tenantId, conversationId, signal } = input;

  // El negocio viene de la tarea, nunca del contenido: una tarea no ve otro negocio.
  const [conversation] = await db
    .select({
      customerId: conversations.customerId,
      assistantStatus: conversations.assistantStatus,
      pausedUntil: conversations.pausedUntil,
      pendingReply: conversations.pendingReply,
      pendingReplyAt: conversations.pendingReplyAt,
    })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
  if (!conversation) return 'not_found';

  const { customerId } = conversation;
  const target: ReplyTarget = {
    tenantId,
    conversationId,
    customerId,
    logger: deps.logger.child({ tenant_id: tenantId, conversation_id: conversationId }),
  };

  const resentLeftover = await sendLeftoverReply(
    deps,
    target,
    { reply: conversation.pendingReply, savedAt: conversation.pendingReplyAt },
    signal,
  );

  const pending = await db
    .select({
      id: messages.id,
      type: messages.type,
      content: messages.content,
      occurredAt: messages.occurredAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'inbound'),
        isNull(messages.processedAt),
      ),
    )
    .orderBy(asc(messages.occurredAt), asc(messages.createdAt));
  if (pending.length === 0) return resentLeftover ? 'replied' : 'nothing_new';

  const pendingIds = pending.map((message) => message.id);
  const markProcessed = (queryable: Queryable) =>
    queryable
      .update(messages)
      .set({ processedAt: deps.now() })
      .where(and(eq(messages.tenantId, tenantId), inArray(messages.id, pendingIds)));

  const [tenant] = await db.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId));
  if (tenant?.status !== 'active') {
    target.logger.warn(
      { status: tenant?.status },
      'El negocio no está activo: los mensajes se marcan como procesados sin contestar',
    );
    await markProcessed(db);
    return 'tenant_inactive';
  }

  if (conversation.assistantStatus === 'paused') {
    // Pausa sin fecha = hasta que se reanude a mano. Con fecha, vence sola: no hay tarea que la reanude (4.8).
    const stillPaused = conversation.pausedUntil === null || conversation.pausedUntil.getTime() > deps.now().getTime();
    if (stillPaused) {
      // El comprobante de una seña se registra igual (4.5): sin él, el turno se vencería aunque la clienta pagó.
      const receipt = await registerReceiptWhilePaused(db, { tenantId, customerId, messages: pending, now: deps.now() });
      if (receipt) target.logger.info({ receipt: receipt.kind }, 'Imagen con el asistente pausado');
      // Lo mismo el «Confirmo» del recordatorio (4.7): es un dato, no habla con la clienta.
      const confirmations = await registerReminderConfirmations(db, { tenantId, customerId, messages: pending, now: deps.now() });
      if (confirmations.size > 0) target.logger.info({ confirmations: confirmations.size }, '«Confirmo» con el asistente pausado');
      await markProcessed(db);
      return 'paused';
    }
    // `resumedAt` marca el corte del historial: lo anterior ya lo atendió una persona (4.8).
    await db
      .update(conversations)
      .set({ assistantStatus: 'active', pausedUntil: null, resumedAt: deps.now() })
      .where(
        and(
          eq(conversations.tenantId, tenantId),
          eq(conversations.id, conversationId),
          eq(conversations.assistantStatus, 'paused'),
        ),
      );
  }

  const reply = await deps.respond(
    { tenantId, conversationId, customerId, messages: pending },
    { signal },
  );
  if (!reply) {
    await markProcessed(db);
    return 'no_reply';
  }

  // La respuesta se guarda junto con la marca de procesados, y recién después se envía (6.7).
  const savedAt = deps.now();
  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({ pendingReply: reply, pendingReplyAt: savedAt })
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
    await markProcessed(tx);
  });
  await deliverPendingReply(deps, target, { message: reply, savedAt }, signal);

  return 'replied';
}

const processConversationPayload = z.object({ conversationId: z.uuid() });

/** El handler de las tareas `process_conversation` para el worker. */
export function conversationJobHandler(deps: ConversationDependencies): JobHandler {
  return async (job, { signal }) => {
    const payload = processConversationPayload.safeParse(job.payload);
    if (!payload.success) {
      throw new Error(`Datos de la tarea inválidos: ${z.prettifyError(payload.error)}`);
    }
    const { conversationId } = payload.data;
    await processConversation(deps, { tenantId: job.tenantId, conversationId, signal });
  };
}
