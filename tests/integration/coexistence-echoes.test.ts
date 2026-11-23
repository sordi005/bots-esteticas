import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { HANDOFF_PAUSE_MS } from '../../src/modules/conversation/handoff.js';
import { recordWebhookEvents } from '../../src/modules/conversation/inbox.js';
import { conversations, handoffs, messages } from '../../src/modules/conversation/schema.js';
import { customers } from '../../src/modules/customers/schema.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { notifications } from '../../src/modules/notifications/schema.js';
import { parseWebhook } from '../../src/modules/whatsapp/webhook-payload.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single } from './support/fixtures.js';
import { connectWhatsApp, echoWebhook, textMessageWebhook } from './support/whatsapp.js';

/** Ecos de la coexistencia (4.8, 6.5, 8.1): la dueña escribe desde su app y el asistente se calla. */
const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(async () => {
  await database.close();
});

const CUSTOMER = '5492614000001';
const ECHO_AT = new Date('2026-11-06T15:00:00Z');
const seconds = (at: Date) => Math.floor(at.getTime() / 1000);
const wamid = () => `wamid.${randomUUID()}`;

async function connectedTenant() {
  const { tenantId } = await createTenantFixture(db);
  return { tenantId, phoneNumberId: await connectWhatsApp(db, tenantId) };
}

function receive(body: string, now = ECHO_AT, notificationsPhoneNumberId?: string) {
  return recordWebhookEvents(db, parseWebhook(JSON.parse(body)).events, {
    now,
    ...(notificationsPhoneNumberId ? { notificationsPhoneNumberId } : {}),
  });
}

function echo(phoneNumberId: string, input: { at?: Date; messageId?: string; to?: string; type?: string; content?: Record<string, unknown> } = {}) {
  return echoWebhook({
    phoneNumberId,
    to: input.to ?? CUSTOMER,
    messageId: input.messageId ?? wamid(),
    timestamp: seconds(input.at ?? ECHO_AT),
    ...(input.type ? { type: input.type } : {}),
    ...(input.content ? { content: input.content } : {}),
  });
}

async function conversationOf(tenantId: string, phone = `+${CUSTOMER}`) {
  const customer = single(
    await db.select({ id: customers.id }).from(customers).where(and(eq(customers.tenantId, tenantId), eq(customers.phone, phone))),
  );
  return single(
    await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.customerId, customer.id))),
  );
}

async function setPause(tenantId: string, conversationId: string, pausedUntil: Date | null) {
  await db
    .update(conversations)
    .set({ assistantStatus: 'paused', pausedUntil })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
}

describe('inbox: guardar los ecos (6.5, H13)', () => {
  it('guarda el eco como mensaje de la dueña en la conversación de la clienta', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    await receive(textMessageWebhook({ phoneNumberId, from: CUSTOMER, messageId: wamid(), text: 'Hola' }));
    const messageId = wamid();

    const summary = await receive(echo(phoneNumberId, { messageId }));

    expect(summary.echoes).toBe(1);
    const conversation = await conversationOf(tenantId);
    const echoes = await db
      .select()
      .from(messages)
      .where(and(eq(messages.tenantId, tenantId), eq(messages.direction, 'echo')));
    expect(echoes).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        type: 'text',
        whatsappMessageId: messageId,
        occurredAt: ECHO_AT,
        processedAt: null,
        content: expect.objectContaining({ text: { body: 'Hola, te escribo yo' } }) as unknown,
      }),
    ]);
  });

  it('si Meta reintenta el mismo eco, se guarda una sola vez', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    const body = echo(phoneNumberId);

    await receive(body);
    const retry = await receive(body);

    expect(retry).toMatchObject({ echoes: 0, duplicates: 1 });
    expect(await db.select().from(messages).where(eq(messages.tenantId, tenantId))).toHaveLength(1);
  });

  it('si la dueña le escribe primero a alguien, crea la clienta y su conversación sin programar ninguna vuelta', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();

    await receive(echo(phoneNumberId, { to: '5492614999999' }));

    const conversation = await conversationOf(tenantId, '+5492614999999');
    const customer = single(await db.select().from(customers).where(eq(customers.id, conversation.customerId)));
    expect(customer.whatsappProfileName).toBeNull();
    expect(conversation.lastMessageAt).toEqual(ECHO_AT);
    expect(await db.select().from(scheduledJobs).where(eq(scheduledJobs.tenantId, tenantId))).toEqual([]);
  });

  it('lo que llega al número de avisos no es un eco de un negocio y se ignora', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();

    const summary = await receive(echo(phoneNumberId), ECHO_AT, phoneNumberId);

    expect(summary.echoes).toBe(0);
    expect(await db.select().from(messages).where(eq(messages.tenantId, tenantId))).toEqual([]);
  });

  it('un eco a un destinatario que no es un número válido se cuenta como inválido', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();

    const summary = await receive(echo(phoneNumberId, { to: 'no-es-un-numero' }));

    expect(summary).toMatchObject({ echoes: 0, invalid: 1 });
    expect(await db.select().from(messages).where(eq(messages.tenantId, tenantId))).toEqual([]);
  });

  it('un eco de un número que no es de ningún negocio se ignora', async () => {
    const summary = await receive(echo('999999999999'));

    expect(summary).toMatchObject({ echoes: 0, unknownNumber: 1 });
  });
});

describe('inbox: un eco pausa el asistente (4.8, H13)', () => {
  it('pausa la conversación hasta 12 horas después del eco, sin derivación ni aviso', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();

    await receive(echo(phoneNumberId));

    const conversation = await conversationOf(tenantId);
    expect(conversation).toMatchObject({
      assistantStatus: 'paused',
      pausedUntil: new Date(ECHO_AT.getTime() + HANDOFF_PAUSE_MS),
    });
    expect(await db.select().from(handoffs).where(eq(handoffs.tenantId, tenantId))).toEqual([]);
    expect(await db.select().from(notifications).where(eq(notifications.tenantId, tenantId))).toEqual([]);
  });

  it('cada eco nuevo corre la pausa', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    const later = new Date(ECHO_AT.getTime() + 3 * 60 * 60 * 1_000);

    await receive(echo(phoneNumberId));
    await receive(echo(phoneNumberId, { at: later }), later);

    expect((await conversationOf(tenantId)).pausedUntil).toEqual(new Date(later.getTime() + HANDOFF_PAUSE_MS));
  });

  it('no acorta una pausa más larga que ya tenía', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    await receive(echo(phoneNumberId));
    const conversation = await conversationOf(tenantId);
    const longer = new Date(ECHO_AT.getTime() + 20 * 60 * 60 * 1_000);
    await setPause(tenantId, conversation.id, longer);

    await receive(echo(phoneNumberId));

    expect((await conversationOf(tenantId)).pausedUntil).toEqual(longer);
  });

  it('una pausa sin fecha (hasta que se reanude a mano) sigue sin fecha', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    await receive(echo(phoneNumberId));
    const conversation = await conversationOf(tenantId);
    await setPause(tenantId, conversation.id, null);

    await receive(echo(phoneNumberId));

    expect(await conversationOf(tenantId)).toMatchObject({ assistantStatus: 'paused', pausedUntil: null });
  });

  it('vuelve a pausar una conversación que ya se había reanudado', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    await receive(textMessageWebhook({ phoneNumberId, from: CUSTOMER, messageId: wamid(), text: 'Hola' }));

    await receive(echo(phoneNumberId));

    expect(await conversationOf(tenantId)).toMatchObject({ assistantStatus: 'paused' });
  });

  it('un eco que llega cuando sus 12 horas ya pasaron se guarda pero no pausa', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    await receive(textMessageWebhook({ phoneNumberId, from: CUSTOMER, messageId: wamid(), text: 'Hola' }));
    const muchLater = new Date(ECHO_AT.getTime() + HANDOFF_PAUSE_MS);

    const summary = await receive(echo(phoneNumberId), muchLater);

    expect(summary.echoes).toBe(1);
    expect(await conversationOf(tenantId)).toMatchObject({ assistantStatus: 'active', pausedUntil: null });
  });

  it.each([
    ['revoke', { original_message_id: 'wamid.borrado' }],
    ['edit', { original_message_id: 'wamid.editado', message: { type: 'text', text: { body: 'Corregido' } } }],
  ])('editar o borrar un mensaje (%s) también pausa: es la dueña atendiendo ese chat', async (type, content) => {
    const { tenantId, phoneNumberId } = await connectedTenant();

    await receive(echo(phoneNumberId, { type, content }));

    expect(await conversationOf(tenantId)).toMatchObject({ assistantStatus: 'paused' });
  });
});
