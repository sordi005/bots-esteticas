import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { customers } from '../customers/schema.js';
import { tenants } from '../tenants/schema.js';
import type {
  InboundMessageEvent,
  MessageStatusEvent,
  WebhookEvent,
} from '../whatsapp/webhook-payload.js';
import { conversations, messages } from './schema.js';

/**
 * Bandeja de entrada (sección 6.5, pasos 2 y 3): identifica el negocio por el
 * `phone_number_id`, crea la clienta y su conversación si hace falta, y guarda el mensaje
 * una sola vez aunque Meta reintente el webhook.
 */
export interface InboxSummary {
  stored: number;
  duplicates: number;
  /** Eventos de un número que no es de ningún negocio. */
  unknownNumber: number;
  /** Mensajes con un remitente que no es un número válido. */
  invalid: number;
  statusesUpdated: number;
  failedDeliveries: { messageId: string; errors: { code: number; title: string }[] }[];
}

const WA_ID = /^[1-9][0-9]{7,14}$/;

export async function recordWebhookEvents(
  db: NodePgDatabase,
  events: WebhookEvent[],
): Promise<InboxSummary> {
  const summary: InboxSummary = {
    stored: 0,
    duplicates: 0,
    unknownNumber: 0,
    invalid: 0,
    statusesUpdated: 0,
    failedDeliveries: [],
  };
  const tenantByNumber = new Map<string, string | null>();

  const findTenant = async (phoneNumberId: string): Promise<string | null> => {
    if (!tenantByNumber.has(phoneNumberId)) {
      const [tenant] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.whatsappPhoneNumberId, phoneNumberId));
      tenantByNumber.set(phoneNumberId, tenant?.id ?? null);
    }
    return tenantByNumber.get(phoneNumberId) ?? null;
  };

  for (const event of events) {
    const tenantId = await findTenant(event.phoneNumberId);
    if (!tenantId) {
      summary.unknownNumber += 1;
    } else if (event.kind === 'message') {
      if (!WA_ID.test(event.from)) {
        summary.invalid += 1;
      } else if (await storeInboundMessage(db, tenantId, event)) {
        summary.stored += 1;
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

/** true si el mensaje es nuevo; false si ya estaba guardado. */
async function storeInboundMessage(
  db: NodePgDatabase,
  tenantId: string,
  event: InboundMessageEvent,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [customer] = await tx
      .insert(customers)
      .values({ tenantId, phone: `+${event.from}`, whatsappProfileName: event.profileName })
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
        direction: 'inbound',
        type: event.type,
        content: event.message,
        whatsappMessageId: event.messageId,
        occurredAt: event.timestamp,
      })
      .onConflictDoNothing({ target: messages.whatsappMessageId })
      .returning({ id: messages.id });

    return inserted.length > 0;
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
