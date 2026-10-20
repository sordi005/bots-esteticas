import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { scheduleJob } from '../jobs/queue.js';
import { tenants } from '../tenants/schema.js';
import type { OwnerReplyAction } from './owner-buttons.js';
import { notifications, ownerReplies, type notificationKind } from './schema.js';

/**
 * Guardar un botón que tocó la dueña (6.5, regla 6): el webhook solo guarda y programa; lo procesa
 * la tarea `process_owner_reply`.
 */

/** Qué botones tiene cada aviso: un botón que no es de ese aviso no se guarda. */
const ACTIONS_BY_KIND: Partial<Record<(typeof notificationKind.enumValues)[number], readonly OwnerReplyAction[]>> = {
  deposit_receipt: ['deposit_received', 'deposit_not_received'],
  handoff: ['handoff_attended'],
};

export type StoreOwnerReplyResult = 'stored' | 'duplicate' | 'not_found';

/**
 * Guarda el botón una sola vez (Meta reintenta) y programa su proceso en la misma transacción.
 * El aviso se busca solo entre los negocios de quien tocó el botón: el id del aviso nunca alcanza
 * para actuar sobre otro negocio (regla 1). En la fase 0 se limita además al negocio del número.
 */
export async function storeOwnerReply(
  db: NodePgDatabase,
  input: {
    /** Quien tocó el botón, en E.164. */
    ownerPhone: string;
    /** Fase 0: el negocio del número por el que llegó. */
    tenantId?: string;
    notificationId: string;
    action: OwnerReplyAction;
    whatsappMessageId: string;
    receivedAt: Date;
    now: Date;
  },
): Promise<StoreOwnerReplyResult> {
  const { notificationId, action } = input;

  return db.transaction(async (tx) => {
    const [notice] = await tx
      .select({ tenantId: notifications.tenantId, kind: notifications.kind })
      .from(notifications)
      .innerJoin(tenants, eq(tenants.id, notifications.tenantId))
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.recipient, 'owner'),
          eq(tenants.ownerPhone, input.ownerPhone),
          ...(input.tenantId ? [eq(notifications.tenantId, input.tenantId)] : []),
        ),
      );
    if (!notice || !ACTIONS_BY_KIND[notice.kind]?.includes(action)) return 'not_found';

    const [reply] = await tx
      .insert(ownerReplies)
      .values({
        tenantId: notice.tenantId,
        notificationId,
        action,
        whatsappMessageId: input.whatsappMessageId,
        receivedAt: input.receivedAt,
      })
      .onConflictDoNothing({ target: ownerReplies.whatsappMessageId })
      .returning({ id: ownerReplies.id });
    if (!reply) return 'duplicate';

    await scheduleJob(tx, {
      tenantId: notice.tenantId,
      kind: 'process_owner_reply',
      key: reply.id,
      payload: { ownerReplyId: reply.id },
      runAt: input.now,
    });
    return 'stored';
  });
}
