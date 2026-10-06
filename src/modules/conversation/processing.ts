import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type { Queryable } from '../../shared/db.js';
import { scheduleJob } from '../jobs/queue.js';
import type { JobHandler } from '../jobs/runner.js';
import type { WhatsAppClient } from '../whatsapp/client.js';
import type { OutgoingMessage } from '../whatsapp/outgoing.js';
import { sendWhatsAppMessage } from './outbox.js';
import { conversations, messages } from './schema.js';

/**
 * Procesar una conversación (secciones 5.2, 6.5 y 6.7): el worker junta los mensajes
 * que la clienta mandó seguidos y contesta una sola vez.
 */

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
 * contestar. Hasta H7 es el eco de desarrollo; después, el agente.
 */
export type Responder = (
  turn: ConversationTurn,
  context: { signal: AbortSignal },
) => Promise<OutgoingMessage | null>;

export interface ConversationDependencies {
  db: NodePgDatabase;
  client: WhatsAppClient;
  credentialsKey: Buffer;
  respond: Responder;
  now: () => Date;
}

export type ProcessResult = 'not_found' | 'nothing_new' | 'replied' | 'no_reply';

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

/**
 * Toma los mensajes entrantes sin procesar, pide una respuesta, la envía y los marca como
 * procesados. Si el envío falla, el error sube y los mensajes quedan para el reintento.
 * Si el envío sale pero falla la marca, el reintento puede repetir la respuesta: es
 * preferible contestar dos veces a no contestar (sección 6.7).
 */
export async function processConversation(
  deps: ConversationDependencies,
  input: { tenantId: string; conversationId: string; signal: AbortSignal },
): Promise<ProcessResult> {
  const { db, now } = deps;
  const { tenantId, conversationId, signal } = input;

  // El negocio viene de la tarea, nunca del contenido: una tarea no ve otro negocio.
  const [conversation] = await db
    .select({ customerId: conversations.customerId })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
  if (!conversation) return 'not_found';

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
  if (pending.length === 0) return 'nothing_new';

  const { customerId } = conversation;
  const reply = await deps.respond(
    { tenantId, conversationId, customerId, messages: pending },
    { signal },
  );

  if (reply) {
    // Si ya venció el tiempo de la tarea, mejor no mandar nada: cuenta como fallo y se reintenta.
    signal.throwIfAborted();
    const result = await sendWhatsAppMessage(
      { db, client: deps.client, credentialsKey: deps.credentialsKey, now: now() },
      { tenantId, customerId, message: reply },
    );
    if (!result.ok) {
      throw new Error(`No se pudo contestar la conversación: ${result.reason}`);
    }
  }

  await db
    .update(messages)
    .set({ processedAt: now() })
    .where(
      and(
        eq(messages.tenantId, tenantId),
        inArray(
          messages.id,
          pending.map((message) => message.id),
        ),
      ),
    );

  return reply ? 'replied' : 'no_reply';
}

const processConversationPayload = z.object({ conversationId: z.uuid() });

/** El handler de las tareas `process_conversation` para el worker. */
export function conversationJobHandler(deps: ConversationDependencies): JobHandler {
  return async (job, { signal }) => {
    const { conversationId } = processConversationPayload.parse(job.payload);
    await processConversation(deps, { tenantId: job.tenantId, conversationId, signal });
  };
}
