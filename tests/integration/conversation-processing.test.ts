import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createAgentResponder } from '../../src/modules/conversation/agent/agent-responder.js';
import { recordWebhookEvents } from '../../src/modules/conversation/inbox.js';
import type { ConversationTurn, Responder } from '../../src/modules/conversation/processing.js';
import { processConversation } from '../../src/modules/conversation/processing.js';
import { agentRuns, conversations, messages } from '../../src/modules/conversation/schema.js';
import { scheduleJob } from '../../src/modules/jobs/queue.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { saveCredential } from '../../src/modules/tenants/credentials.js';
import { tenants } from '../../src/modules/tenants/schema.js';
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
import { finalAnswer, scriptedLlm, type ScriptStep } from '../support/fake-llm.js';
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

async function pendingReplyOf(conversationId: string) {
  return single(
    await db
      .select({ pendingReply: conversations.pendingReply, pendingReplyAt: conversations.pendingReplyAt })
      .from(conversations)
      .where(eq(conversations.id, conversationId)),
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

  it('si el envío falla, la respuesta queda guardada y se reintenta a los 30 segundos sin volver a llamar al respondedor', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp(1);
    const { turns, respond } = recordingResponder();
    let clock = at(4);
    const run = worker({ client, respond, now: () => clock });

    await receive(tenant.phoneNumberId, 'hola', at(0));
    await run.runOnce();

    expect(await jobOf(tenant.tenantId)).toMatchObject({
      status: 'pending',
      runAt: at(34),
      lastError: expect.stringContaining('not in allowed list') as unknown,
    });
    // Los mensajes ya quedaron procesados: lo que falta enviar es la respuesta guardada (6.7).
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
    expect(await pendingReplyOf(tenant.conversationId)).toMatchObject({
      pendingReply: { type: 'text', body: 'hola' },
      pendingReplyAt: at(4),
    });

    clock = at(34);
    await run.runOnce();

    expect(turns).toHaveLength(1);
    expect(delivered.map(bodyOf)).toEqual(['hola']);
    expect(await pendingReplyOf(tenant.conversationId)).toEqual({ pendingReply: null, pendingReplyAt: null });
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

/** Procesa la conversación directamente, con un log que se puede leer. */
function directly(input: { client: WhatsAppClient; respond: Responder; now: () => Date }) {
  const lines: string[] = [];
  const captured = createLogger(
    { logLevel: 'debug' },
    {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  );
  const deps = { db, credentialsKey, logger: captured, ...input };
  const process = (tenantId: string, conversationId: string) =>
    processConversation(deps, { tenantId, conversationId, signal: new AbortController().signal });
  return { process, lines };
}

const pauseConversation = (conversationId: string, pausedUntil: Date | null) =>
  db
    .update(conversations)
    .set({ assistantStatus: 'paused', pausedUntil })
    .where(eq(conversations.id, conversationId));

const savePendingReply = (conversationId: string, body: string, savedAt: Date) =>
  db
    .update(conversations)
    .set({ pendingReply: { type: 'text', body }, pendingReplyAt: savedAt })
    .where(eq(conversations.id, conversationId));

describe('asistente pausado por una derivación (4.8)', () => {
  it('con la pausa vigente, los mensajes se marcan como procesados sin llamar al respondedor ni contestar', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const { turns, respond } = recordingResponder();
    const run = worker({ client, respond, now: () => at(4) });
    await pauseConversation(tenant.conversationId, at(3_600));

    await receive(tenant.phoneNumberId, 'hola, ¿están?', at(0));
    await run.runOnce();

    expect(turns).toEqual([]);
    expect(delivered).toEqual([]);
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
    expect((await jobOf(tenant.tenantId)).status).toBe('done');
  });

  it('una pausa sin fecha dura hasta que se reanude a mano', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const { turns, respond } = recordingResponder();
    const run = worker({ client, respond, now: () => at(4) });
    await pauseConversation(tenant.conversationId, null);

    await receive(tenant.phoneNumberId, 'hola', at(0));
    await run.runOnce();

    expect(turns).toEqual([]);
    expect(delivered).toEqual([]);
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
  });

  it('el resultado dice que estaba pausada, y la pausa sigue', async () => {
    const tenant = await readyTenant();
    const { client } = fakeWhatsApp();
    const { respond } = recordingResponder();
    await pauseConversation(tenant.conversationId, at(3_600));
    await receive(tenant.phoneNumberId, 'hola', at(0));

    const { process } = directly({ client, respond, now: () => at(4) });

    expect(await process(tenant.tenantId, tenant.conversationId)).toBe('paused');
    expect(await db.select().from(conversations).where(eq(conversations.id, tenant.conversationId))).toEqual([
      expect.objectContaining({ assistantStatus: 'paused', pausedUntil: at(3_600) }),
    ]);
  });

  it('con la pausa vencida, el asistente vuelve a estar activo y contesta', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const { turns, respond } = recordingResponder();
    const run = worker({ client, respond, now: () => at(4) });
    await pauseConversation(tenant.conversationId, at(3));

    await receive(tenant.phoneNumberId, 'hola', at(0));
    await run.runOnce();

    expect(turns).toHaveLength(1);
    expect(delivered.map(bodyOf)).toEqual(['hola']);
    expect(await db.select().from(conversations).where(eq(conversations.id, tenant.conversationId))).toEqual([
      expect.objectContaining({ assistantStatus: 'active', pausedUntil: null }),
    ]);
  });

  it('la pausa que vence justo ahora ya no pausa', async () => {
    const tenant = await readyTenant();
    const { client } = fakeWhatsApp();
    const { respond } = recordingResponder();
    await pauseConversation(tenant.conversationId, at(4));
    await receive(tenant.phoneNumberId, 'hola', at(0));

    const { process } = directly({ client, respond, now: () => at(4) });

    expect(await process(tenant.tenantId, tenant.conversationId)).toBe('replied');
  });

  it('si el respondedor deriva durante la vuelta, la respuesta igual sale: es el aviso de la derivación', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const respond: Responder = async (turn) => {
      await pauseConversation(turn.conversationId, at(3_600));
      return { type: 'text', body: 'Una persona te va a responder por acá.' };
    };
    const run = worker({ client, respond, now: () => at(4) });

    await receive(tenant.phoneNumberId, 'quiero hablar con alguien', at(0));
    await run.runOnce();

    expect(delivered.map(bodyOf)).toEqual(['Una persona te va a responder por acá.']);
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
  });
});

describe('negocio que no está activo (6.7)', () => {
  it.each(['paused', 'cancelled'] as const)(
    'con el negocio en estado %s, marca los mensajes como procesados sin contestar y avisa en el log',
    async (status) => {
      const tenant = await readyTenant();
      await db.update(tenants).set({ status }).where(eq(tenants.id, tenant.tenantId));
      const { client, delivered } = fakeWhatsApp();
      const { turns, respond } = recordingResponder();
      await receive(tenant.phoneNumberId, 'un dato personal', at(0));
      const { process, lines } = directly({ client, respond, now: () => at(4) });

      expect(await process(tenant.tenantId, tenant.conversationId)).toBe('tenant_inactive');

      expect(turns).toEqual([]);
      expect(delivered).toEqual([]);
      expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
      const warning = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.level === 40);
      expect(warning).toMatchObject({ tenant_id: tenant.tenantId, conversation_id: tenant.conversationId, status });
      expect(lines.join('')).not.toContain('un dato personal');
    },
  );
});

describe('respuesta guardada sin enviar (6.7)', () => {
  it('el reintento reenvía lo guardado y no llama al respondedor, aunque llegue otro mensaje en el medio', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp(1);
    const { turns, respond } = recordingResponder((turn) => ({
      type: 'text',
      body: textsOf(turn).includes('gracias') ? 'De nada.' : 'Cancelé tu turno del martes.',
    }));
    let clock = at(4);
    const run = worker({ client, respond, now: () => clock });

    await receive(tenant.phoneNumberId, 'cancelame el turno', at(0));
    await run.runOnce();
    expect(delivered).toEqual([]);

    await receive(tenant.phoneNumberId, 'gracias', at(10));
    clock = at(34);
    await run.runOnce();

    // Primero sale lo guardado; el mensaje nuevo se atiende en la misma tarea, con una vuelta propia.
    expect(delivered.map(bodyOf)).toEqual(['Cancelé tu turno del martes.', 'De nada.']);
    expect(turns.map(textsOf)).toEqual([['cancelame el turno'], ['gracias']]);
    expect(await pendingReplyOf(tenant.conversationId)).toEqual({ pendingReply: null, pendingReplyAt: null });
  });

  it('si el envío de lo guardado falla otra vez, el error sube y no se llama al modelo', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp(1);
    const { turns, respond } = recordingResponder();
    await savePendingReply(tenant.conversationId, 'Respuesta de antes', at(0));
    await receive(tenant.phoneNumberId, 'hola de nuevo', at(1));
    const { process } = directly({ client, respond, now: () => at(10) });

    await expect(process(tenant.tenantId, tenant.conversationId)).rejects.toThrow('not in allowed list');

    expect(turns).toEqual([]);
    expect(delivered).toEqual([]);
    expect(await unprocessedOf(tenant.tenantId)).toHaveLength(1);
    expect((await pendingReplyOf(tenant.conversationId)).pendingReply).toEqual({
      type: 'text',
      body: 'Respuesta de antes',
    });
  });

  it('una respuesta guardada de hace más de 5 minutos se descarta con un aviso, sin contenido', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const { respond } = recordingResponder();
    await savePendingReply(tenant.conversationId, 'Tu turno quedó para el martes', at(0));
    const { process, lines } = directly({ client, respond, now: () => at(5 * 60 + 1) });

    expect(await process(tenant.tenantId, tenant.conversationId)).toBe('nothing_new');

    expect(delivered).toEqual([]);
    expect(await pendingReplyOf(tenant.conversationId)).toEqual({ pendingReply: null, pendingReplyAt: null });
    const warning = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.level === 40);
    expect(warning).toMatchObject({ tenant_id: tenant.tenantId, conversation_id: tenant.conversationId });
    expect(lines.join('')).not.toContain('martes');
  });

  it('con exactamente 5 minutos todavía se envía', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const { respond } = recordingResponder();
    await savePendingReply(tenant.conversationId, 'Justo a tiempo', at(0));
    const { process } = directly({ client, respond, now: () => at(5 * 60) });

    expect(await process(tenant.tenantId, tenant.conversationId)).toBe('replied');

    expect(delivered.map(bodyOf)).toEqual(['Justo a tiempo']);
    expect(await pendingReplyOf(tenant.conversationId)).toEqual({ pendingReply: null, pendingReplyAt: null });
  });

  it('se envía aunque la conversación esté pausada: puede ser el mensaje de la derivación', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const { turns, respond } = recordingResponder();
    await pauseConversation(tenant.conversationId, at(43_200));
    await savePendingReply(tenant.conversationId, 'Una persona te responde mañana a las 9:00.', at(0));
    await receive(tenant.phoneNumberId, 'ok', at(1));
    const { process } = directly({ client, respond, now: () => at(30) });

    expect(await process(tenant.tenantId, tenant.conversationId)).toBe('paused');

    expect(delivered.map(bodyOf)).toEqual(['Una persona te responde mañana a las 9:00.']);
    expect(turns).toEqual([]);
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
  });

  it('una respuesta guardada que no es un mensaje válido se descarta en vez de trabar la conversación', async () => {
    const tenant = await readyTenant();
    const { client, delivered } = fakeWhatsApp();
    const { respond } = recordingResponder();
    await db
      .update(conversations)
      .set({ pendingReply: { type: 'text' } as never, pendingReplyAt: at(0) })
      .where(eq(conversations.id, tenant.conversationId));
    const { process, lines } = directly({ client, respond, now: () => at(10) });

    await process(tenant.tenantId, tenant.conversationId);

    expect(delivered).toEqual([]);
    expect(await pendingReplyOf(tenant.conversationId)).toEqual({ pendingReply: null, pendingReplyAt: null });
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>).some((line) => line.level === 40)).toBe(true);
  });

  it('si llegó una respuesta guardada nueva mientras se enviaba la vieja, no se borra la nueva', async () => {
    const tenant = await readyTenant();
    const { client } = fakeWhatsApp();
    const sendingOld: WhatsAppClient = {
      sendMessage: async (input) => {
        await savePendingReply(tenant.conversationId, 'Respuesta nueva', at(20));
        return client.sendMessage(input);
      },
    };
    const { respond } = recordingResponder();
    await savePendingReply(tenant.conversationId, 'Respuesta vieja', at(0));
    const { process } = directly({ client: sendingOld, respond, now: () => at(10) });

    await process(tenant.tenantId, tenant.conversationId);

    expect(await pendingReplyOf(tenant.conversationId)).toMatchObject({
      pendingReply: { type: 'text', body: 'Respuesta nueva' },
      pendingReplyAt: at(20),
    });
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

describe('el agente contesta en el worker (8.5), en lugar del eco', () => {
  /** Lo que llega por el webhook, con la hora de WhatsApp igual a la de la prueba (el historial mira 24 horas). */
  async function receiveAt(phoneNumberId: string, text: string, now: Date) {
    const { events } = parseWebhook(
      JSON.parse(
        textMessageWebhook({
          phoneNumberId,
          from: FIXTURE_CUSTOMER_PHONE.slice(1),
          messageId: `wamid.${randomUUID()}`,
          text,
          timestamp: Math.floor(now.getTime() / 1_000),
        }),
      ),
    );
    await recordWebhookEvents(db, events, { now });
  }

  function agentWorker(script: ScriptStep[], clock: () => Date) {
    const { client, delivered } = fakeWhatsApp();
    const { llm, requests } = scriptedLlm(script);
    const respond = createAgentResponder({ db, llm, logger, now: clock });
    return { run: worker({ client, respond, now: clock }), delivered, requests };
  }

  it('contesta lo que dice el modelo, registra la vuelta y en la siguiente ya ve lo que se dijo', async () => {
    const tenant = await readyTenant();
    let clock = at(6);
    const { run, delivered, requests } = agentWorker(
      [finalAnswer('Hola, soy Luna, asistente virtual de Negocio.'), finalAnswer('Cuesta $18.000.')],
      () => clock,
    );

    await receiveAt(tenant.phoneNumberId, 'hola', at(0));
    await run.runOnce();

    expect(delivered.map(bodyOf)).toEqual(['Hola, soy Luna, asistente virtual de Negocio.']);
    expect(requests[0]?.turnContext).toContain('Conversación nueva: sí');
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
    expect(
      await db.select({ outcome: agentRuns.outcome }).from(agentRuns).where(eq(agentRuns.tenantId, tenant.tenantId)),
    ).toEqual([{ outcome: 'replied' }]);

    await receiveAt(tenant.phoneNumberId, '¿cuánto sale?', at(30));
    clock = at(40);
    await run.runOnce();

    expect(delivered.map(bodyOf)).toEqual(['Hola, soy Luna, asistente virtual de Negocio.', 'Cuesta $18.000.']);
    expect(requests[1]?.turnContext).toContain('Conversación nueva: no');
    expect(requests[1]?.messages).toEqual([
      { role: 'user', text: 'hola' },
      { role: 'assistant', text: 'Hola, soy Luna, asistente virtual de Negocio.' },
      { role: 'user', text: '¿cuánto sale?' },
    ]);
  });

  it('tres mensajes seguidos llegan juntos al modelo y se contestan una sola vez', async () => {
    const tenant = await readyTenant();
    const { run, delivered, requests } = agentWorker([finalAnswer('Sí, tengo.')], () => at(8));

    await receiveAt(tenant.phoneNumberId, 'hola', at(0));
    await receiveAt(tenant.phoneNumberId, 'quería saber', at(1));
    await receiveAt(tenant.phoneNumberId, 'si tenés turno mañana', at(2));
    await run.runOnce();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual([
      { role: 'user', text: 'hola' },
      { role: 'user', text: 'quería saber' },
      { role: 'user', text: 'si tenés turno mañana' },
    ]);
    expect(delivered.map(bodyOf)).toEqual(['Sí, tengo.']);
  });

  it('si el proveedor de IA falla, no se contesta nada y la tarea se reintenta a los 30 segundos', async () => {
    const tenant = await readyTenant();
    let clock = at(6);
    const { run, delivered } = agentWorker(
      [
        () => {
          throw new Error('529 overloaded');
        },
        finalAnswer('Ahora sí.'),
      ],
      () => clock,
    );

    await receiveAt(tenant.phoneNumberId, 'hola', at(0));
    await run.runOnce();

    expect(delivered).toEqual([]);
    expect(await unprocessedOf(tenant.tenantId)).toHaveLength(1);
    expect(await jobOf(tenant.tenantId)).toMatchObject({
      status: 'pending',
      lastError: expect.stringContaining('529 overloaded') as unknown,
    });

    clock = at(40);
    await run.runOnce();

    expect(delivered.map(bodyOf)).toEqual(['Ahora sí.']);
    expect(await unprocessedOf(tenant.tenantId)).toEqual([]);
  });
});
