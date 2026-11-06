import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Queryable } from '../../shared/db.js';
import { customers } from '../customers/schema.js';
import { parseOwnerButtonId } from '../notifications/owner-buttons.js';
import { storeOwnerReply } from '../notifications/replies.js';
import { tenants } from '../tenants/schema.js';
import {
  type EchoEvent,
  inboundContent,
  type InboundMessageEvent,
  type MessageStatusEvent,
  type WebhookEvent,
} from '../whatsapp/webhook-payload.js';
import { HANDOFF_PAUSE_MS } from './handoff.js';
import { scheduleConversation } from './processing.js';
import { conversations, messages } from './schema.js';

/**
 * Bandeja de entrada (sección 6.5, pasos 2, 3 y 5): identifica el negocio por el
 * `phone_number_id`, crea la clienta y su conversación si hace falta, guarda el mensaje
 * una sola vez aunque Meta reintente el webhook y programa la vuelta de la conversación.
 *
 * Los botones de los avisos que toca la dueña no son mensajes de clienta: se guardan aparte y los
 * procesa una tarea (6.5, paso 2; 8.2).
 */
export interface InboxSummary {
  stored: number;
  /** Mensajes que la dueña mandó desde su app (coexistencia, 8.1), guardados por primera vez. */
  echoes: number;
  duplicates: number;
  /** Botones de avisos que tocó la dueña, guardados para procesar. */
  ownerReplies: number;
  /** Lo que llegó al número de avisos y no es un botón de un aviso de esa dueña. */
  ownerIgnored: number;
  /** Eventos de un número que no es de ningún negocio. */
  unknownNumber: number;
  /** Mensajes con un remitente que no es un número válido. */
  invalid: number;
  statusesUpdated: number;
  failedDeliveries: { messageId: string; errors: { code: number; title: string }[] }[];
}

const WA_ID = /^[1-9][0-9]{7,14}$/;

/** El botón de un aviso, si el mensaje es uno (6.5). */
function ownerButton(event: InboundMessageEvent) {
  const { replyId } = inboundContent(event.message);
  return replyId ? parseOwnerButtonId(replyId) : null;
}

export async function recordWebhookEvents(
  db: NodePgDatabase,
  events: WebhookEvent[],
  options: {
    now: Date;
    /** El número de avisos del servicio (8.2): lo que entra por ahí es de una dueña. */
    notificationsPhoneNumberId?: string;
  },
): Promise<InboxSummary> {
  const summary: InboxSummary = {
    stored: 0,
    echoes: 0,
    duplicates: 0,
    ownerReplies: 0,
    ownerIgnored: 0,
    unknownNumber: 0,
    invalid: 0,
    statusesUpdated: 0,
    failedDeliveries: [],
  };
  const tenantByNumber = new Map<string, { id: string; ownerPhone: string | null } | null>();

  const findTenant = async (phoneNumberId: string) => {
    if (!tenantByNumber.has(phoneNumberId)) {
      const [tenant] = await db
        .select({ id: tenants.id, ownerPhone: tenants.ownerPhone })
        .from(tenants)
        .where(eq(tenants.whatsappPhoneNumberId, phoneNumberId));
      tenantByNumber.set(phoneNumberId, tenant ?? null);
    }
    return tenantByNumber.get(phoneNumberId) ?? null;
  };

  /** Guarda el botón de la dueña. `tenantId`: en la fase 0, solo los avisos de ese negocio. */
  const recordOwnerReply = async (event: InboundMessageEvent, tenantId?: string) => {
    const button = WA_ID.test(event.from) ? ownerButton(event) : null;
    const result = button
      ? await storeOwnerReply(db, {
          ownerPhone: `+${event.from}`,
          ...(tenantId ? { tenantId } : {}),
          notificationId: button.notificationId,
          action: button.action,
          whatsappMessageId: event.messageId,
          receivedAt: event.timestamp,
          now: options.now,
        })
      : 'not_found';
    if (result === 'stored') summary.ownerReplies += 1;
    else if (result === 'duplicate') summary.duplicates += 1;
    else summary.ownerIgnored += 1;
  };

  for (const event of events) {
    if (options.notificationsPhoneNumberId && event.phoneNumberId === options.notificationsPhoneNumberId) {
      // Los estados de los avisos enviados no se registran: no son mensajes de una conversación.
      if (event.kind === 'message') await recordOwnerReply(event);
      continue;
    }

    const tenant = await findTenant(event.phoneNumberId);
    const tenantId = tenant?.id;
    if (!tenantId) {
      summary.unknownNumber += 1;
    } else if (event.kind === 'message') {
      if (!WA_ID.test(event.from)) {
        summary.invalid += 1;
      } else if (ownerButton(event) && tenant.ownerPhone === `+${event.from}`) {
        // Fase 0: el aviso salió del número del negocio y lo tocó su dueña.
        await recordOwnerReply(event, tenantId);
      } else if (await storeInboundMessage(db, tenantId, event, options.now)) {
        summary.stored += 1;
      } else {
        summary.duplicates += 1;
      }
    } else if (event.kind === 'echo') {
      if (!WA_ID.test(event.to)) {
        summary.invalid += 1;
      } else if (await storeEcho(db, tenantId, event, options.now)) {
        summary.echoes += 1;
      } else {
        summary.duplicates += 1;
      }
    } else {
      if (await recordStatus(db, tenantId, event)) summary.statusesUpdated += 1;
      if (event.status === 'failed') {
        summary.failedDeliveries.push({ messageId: event.messageId, errors: event.errors });
      }
    }
  }

  return summary;
}

/**
 * Guarda el mensaje recibido en la conversación de la clienta, creando las dos si hace falta.
 * Devuelve la conversación, o null si ese id de mensaje ya estaba guardado (Meta reintenta).
 */
async function storeInConversation(
  tx: Queryable,
  tenantId: string,
  input: {
    /** wa_id de la clienta: la que escribió o a la que le escribió la dueña. */
    customerWaId: string;
    profileName: string | null;
    direction: 'inbound' | 'echo';
    event: { messageId: string; timestamp: Date; type: string; message: Record<string, unknown> };
  },
): Promise<string | null> {
  const { event } = input;
  const [customer] = await tx
    .insert(customers)
    .values({ tenantId, phone: `+${input.customerWaId}`, whatsappProfileName: input.profileName })
    .onConflictDoUpdate({
      target: [customers.tenantId, customers.phone],
      set: {
        whatsappProfileName: sql`coalesce(excluded.whatsapp_profile_name, ${customers.whatsappProfileName})`,
      },
    })
    .returning({ id: customers.id });
  if (!customer) throw new Error('La base no devolvió la clienta');

  const [conversation] = await tx
    .insert(conversations)
    .values({ tenantId, customerId: customer.id, lastMessageAt: event.timestamp })
    .onConflictDoUpdate({
      target: [conversations.tenantId, conversations.customerId],
      set: {
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, excluded.last_message_at)`,
      },
    })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error('La base no devolvió la conversación');

  const inserted = await tx
    .insert(messages)
    .values({
      tenantId,
      conversationId: conversation.id,
      direction: input.direction,
      type: event.type,
      content: event.message,
      whatsappMessageId: event.messageId,
      occurredAt: event.timestamp,
    })
    .onConflictDoNothing({ target: messages.whatsappMessageId })
    .returning({ id: messages.id });
  return inserted.length > 0 ? conversation.id : null;
}

/**
 * true si el mensaje es nuevo; false si ya estaba guardado. Un mensaje nuevo programa la
 * vuelta de su conversación en la misma transacción: si se guardó, alguien lo va a contestar.
 * Uno repetido no la toca, así un reintento de Meta no vuelve a correr la espera.
 */
async function storeInboundMessage(
  db: NodePgDatabase,
  tenantId: string,
  event: InboundMessageEvent,
  receivedAt: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const conversationId = await storeInConversation(tx, tenantId, {
      customerWaId: event.from,
      profileName: event.profileName,
      direction: 'inbound',
      event,
    });
    if (!conversationId) return false;

    await scheduleConversation(tx, { tenantId, conversationId, receivedAt });
    return true;
  });
}

/**
 * Guarda el mensaje que la dueña mandó desde su app y, en la misma transacción, pausa el asistente
 * en esa conversación hasta 12 horas después del eco (4.8): si la dueña escribió, el asistente se
 * calla. No programa la vuelta de la conversación (no hay nada que contestar) ni crea una
 * derivación. true si el eco es nuevo.
 */
async function storeEcho(
  db: NodePgDatabase,
  tenantId: string,
  event: EchoEvent,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // El eco no trae el nombre de perfil de la clienta: si ya lo teníamos, queda.
    const conversationId = await storeInConversation(tx, tenantId, {
      customerWaId: event.to,
      profileName: null,
      direction: 'echo',
      event,
    });
    if (!conversationId) return false;

    const pausedUntil = new Date(event.timestamp.getTime() + HANDOFF_PAUSE_MS);
    // Un eco que llegó tan tarde que sus 12 horas ya pasaron se guarda, pero no pausa.
    if (pausedUntil.getTime() <= now.getTime()) return true;

    const until = sql`${pausedUntil.toISOString()}::timestamptz`;
    await tx
      .update(conversations)
      .set({
        assistantStatus: 'paused',
        // Una pausa más larga no se acorta, y una sin fecha (hasta que se reanude a mano) sigue sin fecha.
        pausedUntil: sql`case
          when ${conversations.assistantStatus} = 'paused' and ${conversations.pausedUntil} is null then null
          else greatest(${conversations.pausedUntil}, ${until})
        end`,
      })
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
    return true;
  });
}

/** Guarda la categoría de precio de Meta en el mensaje enviado (sección 8.1). */
async function recordStatus(
  db: NodePgDatabase,
  tenantId: string,
  event: MessageStatusEvent,
): Promise<boolean> {
  if (!event.pricingCategory) return false;
  const updated = await db
    .update(messages)
    .set({ pricingCategory: event.pricingCategory })
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.whatsappMessageId, event.messageId),
        eq(messages.direction, 'outbound'),
      ),
    )
    .returning({ id: messages.id });
  return updated.length > 0;
}
