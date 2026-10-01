import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { recordWebhookEvents } from '../../src/modules/conversation/inbox.js';
import { conversations, messages } from '../../src/modules/conversation/schema.js';
import { customers } from '../../src/modules/customers/schema.js';
import { buildServer } from '../../src/server.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single } from './support/fixtures.js';
import {
  APP_SECRET,
  connectWhatsApp,
  sign,
  statusWebhook,
  textMessageWebhook,
  VERIFY_TOKEN,
} from './support/whatsapp.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

const server = buildServer({
  healthChecks: {},
  whatsappWebhook: {
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    onEvents: async (events) => {
      await recordWebhookEvents(db, events);
    },
  },
});

afterAll(async () => {
  await server.close();
  await database.close();
});

const CUSTOMER = '5492614000001';
const wamid = () => `wamid.${randomUUID()}`;

function post(rawBody: string, signature = sign(rawBody)) {
  return server.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    payload: rawBody,
  });
}

async function connectedTenant() {
  const { tenantId } = await createTenantFixture(db);
  return { tenantId, phoneNumberId: await connectWhatsApp(db, tenantId) };
}

async function messagesOf(tenantId: string) {
  return db.select().from(messages).where(eq(messages.tenantId, tenantId));
}

describe('GET /webhooks/whatsapp: verificación al registrar el webhook en Meta', () => {
  const verify = (token: string, mode = 'subscribe') =>
    server.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=${mode}&hub.verify_token=${token}&hub.challenge=1158201444`,
    });

  it('con el token correcto devuelve el challenge', async () => {
    const response = await verify(VERIFY_TOKEN);

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('1158201444');
  });

  it.each([
    ['un token incorrecto', 'otro-token', 'subscribe'],
    ['otro modo', VERIFY_TOKEN, 'unsubscribe'],
  ])('con %s responde 403', async (_case, token, mode) => {
    expect((await verify(token, mode)).statusCode).toBe(403);
  });
});

describe('POST /webhooks/whatsapp: recepción de mensajes (sección 6.5)', () => {
  it('guarda la clienta, su conversación y el mensaje, y responde 200', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    const messageId = wamid();

    const response = await post(
      textMessageWebhook({ phoneNumberId, from: CUSTOMER, messageId, text: 'hola! tenés turno para semi?', profileName: 'Caro P' }),
    );

    expect(response.statusCode).toBe(200);
    const customer = single(await db.select().from(customers).where(eq(customers.tenantId, tenantId)));
    expect(customer).toMatchObject({ phone: `+${CUSTOMER}`, whatsappProfileName: 'Caro P' });
    const conversation = single(
      await db.select().from(conversations).where(eq(conversations.tenantId, tenantId)),
    );
    expect(conversation).toMatchObject({
      customerId: customer.id,
      assistantStatus: 'active',
      lastMessageAt: new Date(1_790_000_000_000),
    });
    expect(await messagesOf(tenantId)).toMatchObject([
      {
        conversationId: conversation.id,
        direction: 'inbound',
        type: 'text',
        whatsappMessageId: messageId,
        occurredAt: new Date(1_790_000_000_000),
        content: expect.objectContaining({ text: { body: 'hola! tenés turno para semi?' } }) as unknown,
      },
    ]);
  });

  it('si Meta reintenta el mismo webhook, el mensaje se guarda una sola vez (idempotencia)', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    const body = textMessageWebhook({ phoneNumberId, from: CUSTOMER, messageId: wamid(), text: 'hola' });

    expect((await post(body)).statusCode).toBe(200);
    expect((await post(body)).statusCode).toBe(200);

    expect(await messagesOf(tenantId)).toHaveLength(1);
  });

  it('el segundo mensaje de la clienta va a la misma conversación', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    await post(textMessageWebhook({ phoneNumberId, from: CUSTOMER, messageId: wamid(), text: 'hola', timestamp: 1_790_000_000 }));
    await post(textMessageWebhook({ phoneNumberId, from: CUSTOMER, messageId: wamid(), text: 'quería saber', timestamp: 1_790_000_060 }));

    expect(await db.select().from(customers).where(eq(customers.tenantId, tenantId))).toHaveLength(1);
    const conversation = single(
      await db.select().from(conversations).where(eq(conversations.tenantId, tenantId)),
    );
    expect(conversation.lastMessageAt).toEqual(new Date(1_790_000_060_000));
    expect(await messagesOf(tenantId)).toHaveLength(2);
  });

  it('rechaza un webhook con la firma inválida y no guarda nada', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    const body = textMessageWebhook({ phoneNumberId, from: CUSTOMER, messageId: wamid(), text: 'hola' });

    const response = await post(body, sign(body, 'secreto-falso'));

    expect(response.statusCode).toBe(401);
    expect(await messagesOf(tenantId)).toEqual([]);
  });

  it('valida la firma sobre los bytes tal como llegaron', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    // Meta escapa algunos caracteres; si se re-serializara el JSON, la firma no coincidiría.
    const body = textMessageWebhook({ phoneNumberId, from: CUSTOMER, messageId: wamid(), text: 'MARKER' }).replace(
      'MARKER',
      'turno para ma\\u00f1ana',
    );

    expect((await post(body)).statusCode).toBe(200);
    expect(single(await messagesOf(tenantId)).content).toMatchObject({ text: { body: 'turno para mañana' } });
  });

  it('un número que no es de ningún negocio se ignora con 200, sin guardar nada', async () => {
    const messageId = wamid();
    const response = await post(
      textMessageWebhook({ phoneNumberId: '999999999999999', from: CUSTOMER, messageId, text: 'hola' }),
    );

    expect(response.statusCode).toBe(200);
    expect(
      await db.select().from(messages).where(eq(messages.whatsappMessageId, messageId)),
    ).toEqual([]);
  });

  it('la misma persona escribiéndole a dos negocios son dos clientas (sección 4.9)', async () => {
    const a = await connectedTenant();
    const b = await connectedTenant();

    await post(textMessageWebhook({ phoneNumberId: a.phoneNumberId, from: CUSTOMER, messageId: wamid(), text: 'hola A' }));
    await post(textMessageWebhook({ phoneNumberId: b.phoneNumberId, from: CUSTOMER, messageId: wamid(), text: 'hola B' }));

    const [inA] = await messagesOf(a.tenantId);
    const [inB] = await messagesOf(b.tenantId);
    expect(inA?.content).toMatchObject({ text: { body: 'hola A' } });
    expect(inB?.content).toMatchObject({ text: { body: 'hola B' } });
    expect(inA?.conversationId).not.toBe(inB?.conversationId);
  });
});

describe('POST /webhooks/whatsapp: estados de los mensajes enviados', () => {
  it('guarda la categoría de precio de Meta en el mensaje enviado (sección 8.1)', async () => {
    const { tenantId, phoneNumberId } = await connectedTenant();
    const inbound = wamid();
    await post(textMessageWebhook({ phoneNumberId, from: CUSTOMER, messageId: inbound, text: 'hola' }));
    const conversation = single(
      await db.select().from(conversations).where(eq(conversations.tenantId, tenantId)),
    );
    const outbound = wamid();
    await db.insert(messages).values({
      tenantId,
      conversationId: conversation.id,
      direction: 'outbound',
      type: 'text',
      content: { body: '¡Hola! Soy Luna' },
      whatsappMessageId: outbound,
      occurredAt: new Date(1_790_000_050_000),
    });

    expect((await post(statusWebhook({ phoneNumberId, messageId: outbound, status: 'delivered', category: 'service' }))).statusCode).toBe(200);

    const sent = single(
      await db
        .select({ pricingCategory: messages.pricingCategory })
        .from(messages)
        .where(and(eq(messages.tenantId, tenantId), eq(messages.whatsappMessageId, outbound))),
    );
    expect(sent.pricingCategory).toBe('service');
  });
});
