import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { conversations, messages } from '../modules/conversation/schema.js';
import type { Queryable } from '../shared/db.js';

export interface PendingInboundMessage {
  customerId: string;
  content: unknown;
  /** Instante del mensaje: se pasa como `after` en la próxima consulta. */
  cursor: string;
}

/** Mensajes entrantes del negocio guardados después de `after`, del más viejo al más nuevo. */
export async function pendingInboundMessages(
  db: Queryable,
  input: { tenantId: string; after: string },
): Promise<PendingInboundMessage[]> {
  return db
    .select({
      customerId: conversations.customerId,
      content: messages.content,
      // Como texto y no como Date: Postgres guarda microsegundos y Date solo milisegundos.
      // Con un Date, `created_at > cursor` seguiría siendo cierto para el último mensaje
      // y se contestaría para siempre.
      cursor: sql<string>`${messages.createdAt}::text`,
    })
    .from(messages)
    .innerJoin(
      conversations,
      and(eq(conversations.tenantId, messages.tenantId), eq(conversations.id, messages.conversationId)),
    )
    .where(
      and(
        eq(messages.tenantId, input.tenantId),
        eq(messages.direction, 'inbound'),
        gt(messages.createdAt, sql`${input.after}::timestamptz`),
      ),
    )
    .orderBy(asc(messages.createdAt));
}
