import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { recordWebhookEvents } from '../../src/modules/conversation/inbox.js';
import type { ConversationTurn, Responder } from '../../src/modules/conversation/processing.js';
import { messages } from '../../src/modules/conversation/schema.js';
import { scheduleJob } from '../../src/modules/jobs/queue.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { saveCredential } from '../../src/modules/tenants/credentials.js';
import {
  WhatsAppApiError,
  type SendMessageInput,
  type WhatsAppClient,
} from '../../src/modules/whatsapp/client.js';
import type { OutgoingMessage } from '../../src/modules/whatsapp/outgoing.js';
import { inboundContent, parseWebhook } from '../../src/modules/whatsapp/webhook-payload.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { buildWorker } from '../../src/worker.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, FIXTURE_CUSTOMER_PHONE, single } from './support/fixtures.js';
import { gate } from './support/gate.js';
import { connectWhatsApp, textMessageWebhook } from './support/whatsapp.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const credentialsKey = randomBytes(32);
const logger = createLogger({ logLevel: 'silent' });

afterAll(() => database.close());

// La cola es una sola para todos los negocios: cada test arranca sin tareas.
beforeEach(async () => {
  await db.delete(scheduledJobs);
});

const T0 = new Date('2026-10-06T15:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1_000);

/** Un negocio con su número de WhatsApp y su token guardado, listo para contestar. */
async function readyTenant() {
  const fixture = await createTenantFixture(db);
  const phoneNumberId = await connectWhatsApp(db, fixture.tenantId);
  await saveCredential(db, credentialsKey, {
    tenantId: fixture.tenantId,
    kind: 'whatsapp',
    value: { accessToken: 'EAAG-token-del-negocio' },
  });
  return { ...fixture, phoneNumberId };
}

/** Lo que llega por el webhook a la hora `now`. */
async function receive(phoneNumberId: string, text: string, now: Date, messageId = `wamid.${randomUUID()}`) {
  const { events } = parseWebhook(
    JSON.parse(textMessageWebhook({ phoneNumberId, from: FIXTURE_CUSTOMER_PHONE.slice(1), messageId, text })),
  );
  await recordWebhookEvents(db, events, { now });
  return messageId;
}

/** WhatsApp de mentira: anota lo que se entregó. Las primeras `failures` llamadas fallan. */
function fakeWhatsApp(failures = 0) {
  const delivered: SendMessageInput[] = [];
  let calls = 0;
  const client: WhatsAppClient = {
    sendMessage: (input) => {
      calls += 1;
      if (calls <= failures) {
        return Promise.reject(
          new WhatsAppApiError('Meta rechazó el mensaje: Recipient phone number not in allowed list', 400, 131030),
        );
      }
      delivered.push(input);
      return Promise.resolve({ messageId: `wamid.saliente-${randomUUID()}` });
    },
  };
  return { client, delivered };
}

const textsOf = (turn: ConversationTurn) => turn.messages.map((message) => inboundContent(message.content).text);

const bodyOf = (sent: SendMessageInput) => (sent.message.type === 'text' ? sent.message.body : sent.message.type);

/** Contesta con los textos recibidos, y anota cada vuelta. */
function recordingResponder(reply: (turn: ConversationTurn) => OutgoingMessage | null = (turn) => ({
  type: 'text',
  body: textsOf(turn).join(' / '),
})) {
  const turns: ConversationTurn[] = [];
  const respond: Responder = (turn) => {
    turns.push(turn);
    return Promise.resolve(reply(turn));
  };
  return { turns, respond };
}

function worker(input: { client: WhatsAppClient; respond: Responder; now: () => Date }) {
  const created = buildWorker({
    db,
    logger,
    now: input.now,
    conversations: { client: input.client, credentialsKey, respond: input.respond },
  });
  onTestFinished(() => created.stop());
  return created;
}

async function unprocessedOf(tenantId: string) {
  return db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(eq(messages.tenantId, tenantId), eq(messages.direction, 'inbound'), isNull(messages.processedAt)),
    );
}

async function jobOf(tenantId: string) {
  return single(await db.select().from(scheduledJobs).where(eq(scheduledJobs.tenantId, tenantId)));
}

describe('agrupado de mensajes (5.2) y una ejecución por conversación (6.5)', () => {
  it('tres mensajes seguidos se contestan una sola vez, 4 segundos después del último', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const { turns, respond } = recordingResponder();
    let clock = at(0);
    const run = worker({ client, respond, now: () => clock });

    await receive(tenant.phoneNumberId, 'hola', at(0));
    await receive(tenant.phoneNumberId, 'quería saber', at(1));
    await receive(tenant.phoneNumberId, 'si tenés turno mañana', at(2));

    clock = at(5);
    await run.runOnce();
    expect(delivered).toEqual([]);

    clock = at(6);
    await run.runOnce();
    expect(turns.map(textsOf)).toEqual([['hola', 'quería saber', 'si tenés turno mañana']]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      to: FIXTURE_CUSTOMER_PHONE,
      message: { type: 'text', body: 'hola / quería saber / si tenés turno mañana' },
    });
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
  });

  it('lo que llega mientras se contesta va a la próxima vuelta, en otra respuesta', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const firstTurn = gate();
    const turns: ConversationTurn[] = [];
    const respond: Responder = async (turn) => {
      turns.push(turn);
      if (turns.length === 1) await firstTurn.opened;
      return { type: 'text', body: textsOf(turn).join(' / ') };
    };
    let clock = at(4);
    const run = worker({ client, respond, now: () => clock });

    await receive(tenant.phoneNumberId, 'hola', at(0));
    const first = run.runOnce();
    await vi.waitFor(() => {
      expect(turns).toHaveLength(1);
    });
    await receive(tenant.phoneNumberId, 'una cosa más', at(5));
    firstTurn.open();
    await first;
    expect(delivered.map(bodyOf)).toEqual(['hola']);

    clock = at(9);
    await run.runOnce();

    expect(turns.map(textsOf)).toEqual([['hola'], ['una cosa más']]);
    expect(delivered.map(bodyOf)).toEqual(['hola', 'una cosa más']);
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
  });

  it('un webhook repetido no vuelve a correr la espera del agrupado', async () => {
    const tenant = await readyTenant();

    const messageId = await receive(tenant.phoneNumberId, 'hola', at(0));
    await receive(tenant.phoneNumberId, 'hola', at(3), messageId);

    expect(await jobOf(tenant.tenantId)).toMatchObject({
      kind: 'process_conversation',
      key: tenant.conversationId,
      payload: { conversationId: tenant.conversationId },
      runAt: at(4),
    });
  });

  it('si el envío falla, los mensajes siguen sin procesar y se reintenta a los 30 segundos', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp(1);
    const { respond } = recordingResponder();
    let clock = at(4);
    const run = worker({ client, respond, now: () => clock });

    await receive(tenant.phoneNumberId, 'hola', at(0));
    await run.runOnce();

    expect(await jobOf(tenant.tenantId)).toMatchObject({
      status: 'pending',
      runAt: at(34),
      lastError: expect.stringContaining('not in allowed list') as unknown,
    });
    expect(await unprocessedOf(tenant.tenantId)).toHaveLength(1);

    clock = at(34);
    await run.runOnce();

    expect(delivered.map(bodyOf)).toEqual(['hola']);
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
  });

  it('si el respondedor decide no contestar, los mensajes quedan procesados igual', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const { turns, respond } = recordingResponder(() => null);
    const run = worker({ client, respond, now: () => at(4) });

    await receive(tenant.phoneNumberId, 'hola', at(0));
    await run.runOnce();

    expect(turns).toHaveLength(1);
    expect(delivered).toEqual([]);
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
    expect((await jobOf(tenant.tenantId)).status).toBe('done');
  });
});

describe('tareas con datos inválidos', () => {
  it('fallan con un error que se puede leer, sin contestar nada', async () => {
    const tenant = await readyTenant();
    await scheduleJob(db, {
      tenantId: tenant.tenantId,
      kind: 'process_conversation',
      key: tenant.conversationId,
      payload: {},
      runAt: at(0),
    });
    const { client, delivered } = fakeWhatsApp();
    const { turns, respond } = recordingResponder();

    await worker({ client, respond, now: () => at(4) }).runOnce();

    expect(turns).toEqual([]);
    expect(delivered).toEqual([]);
    expect((await jobOf(tenant.tenantId)).lastError).toMatch(/^Datos de la tarea inválidos:.*conversationId/s);
  });
});

describe('aislamiento entre negocios', () => {
  it('una tarea nunca procesa la conversación de otro negocio', async () => {
    const tenant = await readyTenant();
    const other = await readyTenant();
    // Un mensaje sin procesar del otro negocio, y una tarea del primero que apunta a esa conversación.
    await db.insert(messages).values({
      tenantId: other.tenantId,
      conversationId: other.conversationId,
      direction: 'inbound',
      type: 'text',
      content: { type: 'text', text: { body: 'hola' } },
      whatsappMessageId: `wamid.${randomUUID()}`,
      occurredAt: at(0),
    });
    await scheduleJob(db, {
      tenantId: tenant.tenantId,
      kind: 'process_conversation',
      key: other.conversationId,
      payload: { conversationId: other.conversationId },
      runAt: at(0),
    });
    const { client, delivered } = fakeWhatsApp();
    const { turns, respond } = recordingResponder();

    await worker({ client, respond, now: () => at(4) }).runOnce();

    expect(turns).toEqual([]);
    expect(delivered).toEqual([]);
    expect(await unprocessedOf(other.tenantId)).toHaveLength(1);
  });
});
