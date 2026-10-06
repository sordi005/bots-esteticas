import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { customers } from '../customers/schema.js';
import { loadCredential } from '../tenants/credentials.js';
import { tenants } from '../tenants/schema.js';
import { whatsAppCredentialSchema, type WhatsAppClient } from '../whatsapp/client.js';
import type { OutgoingMessage } from '../whatsapp/outgoing.js';
import { conversations, messages } from './schema.js';

/**
 * Envía un mensaje a una clienta por el número de WhatsApp del negocio y lo registra.
 * El negocio y la clienta vienen del contexto del servidor, nunca de la IA (regla 2).
 * Si Meta rechaza el envío, el error sube y no se registra un mensaje que no salió.
 */
export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: 'not_found' | 'not_connected' };

export async function sendWhatsAppMessage(
  deps: { db: NodePgDatabase; client: WhatsAppClient; credentialsKey: Buffer; now: Date },
  input: { tenantId: string; customerId: string; message: OutgoingMessage },
): Promise<SendResult> {
  const { db, client, credentialsKey, now } = deps;
  const { tenantId, customerId, message } = input;

  const [tenant] = await db
    .select({ phoneNumberId: tenants.whatsappPhoneNumberId })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const [customer] = await db
    .select({ phone: customers.phone })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
  if (!tenant || !customer) return { ok: false, reason: 'not_found' };
  if (!tenant.phoneNumberId) return { ok: false, reason: 'not_connected' };

  const credential = whatsAppCredentialSchema.safeParse(
    await loadCredential(db, credentialsKey, { tenantId, kind: 'whatsapp' }),
  );
  if (!credential.success) return { ok: false, reason: 'not_connected' };

  const { messageId } = await client.sendMessage({
    phoneNumberId: tenant.phoneNumberId,
    accessToken: credential.data.accessToken,
    to: customer.phone,
    message,
  });

  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId, customerId })
    .onConflictDoUpdate({
      target: [conversations.tenantId, conversations.customerId],
      set: { updatedAt: now },
    })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error('La base no devolvió la conversación');

  await db.insert(messages).values({
    tenantId,
    conversationId: conversation.id,
    direction: 'outbound',
    type: message.type === 'text' ? 'text' : 'interactive',
    content: message,
    whatsappMessageId: messageId,
    occurredAt: now,
  });

  return { ok: true, messageId };
}
