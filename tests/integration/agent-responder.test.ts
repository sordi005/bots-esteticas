import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAgentResponder,
  MAX_INBOUND_MESSAGES_PER_HOUR,
} from '../../src/modules/conversation/agent/agent-responder.js';
import { FALLBACK_REPLY_TEXT, notUnderstoodHandoffText } from '../../src/modules/conversation/agent/agent.js';
import type { LlmClient, LlmMessage } from '../../src/modules/conversation/agent/llm-client.js';
import { CHOICE_MARKER } from '../../src/modules/conversation/agent/message-text.js';
import type { ReceivedMessage } from '../../src/modules/conversation/processing.js';
import { agentRuns, conversations, handoffs, messages } from '../../src/modules/conversation/schema.js';
import { choiceIds } from '../../src/modules/conversation/tools/choice-ids.js';
import type { AgentTool, ToolContext } from '../../src/modules/conversation/tools/tool.js';
import { customers } from '../../src/modules/customers/schema.js';
import { bookAppointment } from '../../src/modules/scheduling/booking.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import type { OutgoingMessage } from '../../src/modules/whatsapp/outgoing.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { callTools, finalAnswer, promisedHandoffAnswer, scriptedLlm, type ScriptStep } from '../support/fake-llm.js';
import { at, createCatalogFixture, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Lunes 5/10/2026 a las 10:00 en Mendoza.
const NOW = at('2026-10-05', '10:00');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const hoursAgo = (hours: number) => minutesAgo(hours * 60);
const signal = new AbortController().signal;

type Fixture = CatalogFixture & { conversationId: string };

async function setup(
  customerName: string | null = null,
  settings: Parameters<typeof createCatalogFixture>[1] = {},
): Promise<Fixture> {
  const catalog = await createCatalogFixture(db, settings);
  if (customerName) {
    await db.update(customers).set({ name: customerName }).where(eq(customers.id, catalog.customerId));
  }
  const { id: conversationId } = single(
    await db
      .insert(conversations)
      .values({ tenantId: catalog.tenantId, customerId: catalog.customerId })
      .returning({ id: conversations.id }),
  );
  return { ...catalog, conversationId };
}

const textContent = (text: string) => ({ type: 'text', text: { body: text } });

/** Un mensaje entrante ya guardado. `processed: false` lo deja pendiente. */
async function addInbound(
  f: Fixture,
  input: { content?: Record<string, unknown>; type?: string; text?: string; at: Date; processed?: boolean },
): Promise<ReceivedMessage> {
  const type = input.type ?? 'text';
  const content = input.content ?? textContent(input.text ?? 'hola');
  const row = single(
    await db
      .insert(messages)
      .values({
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        direction: 'inbound',
        type,
        content,
        whatsappMessageId: `wamid.${randomUUID()}`,
        occurredAt: input.at,
        processedAt: input.processed === false ? null : input.at,
      })
      .returning({ id: messages.id, occurredAt: messages.occurredAt }),
  );
  return { id: row.id, type, content, occurredAt: row.occurredAt };
}

async function addOutbound(f: Fixture, message: OutgoingMessage, sentAt: Date) {
  await db.insert(messages).values({
    tenantId: f.tenantId,
    conversationId: f.conversationId,
    direction: 'outbound',
    type: message.type === 'text' ? 'text' : 'interactive',
    content: message,
    whatsappMessageId: `wamid.${randomUUID()}`,
    occurredAt: sentAt,
  });
}

/** Una vuelta con mensajes de texto pendientes, 5 segundos antes de ahora. */
async function pendingTexts(f: Fixture, ...texts: string[]): Promise<ReceivedMessage[]> {
  const result: ReceivedMessage[] = [];
  for (const [index, text] of texts.entries()) {
    result.push(await addInbound(f, { text, at: new Date(NOW.getTime() - (texts.length - index) * 1_000), processed: false }));
  }
  return result;
}

function interactiveReply(id: string, title: string) {
  return {
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id, title } },
  };
}

function build(llm: LlmClient, options: { tools?: AgentTool<unknown>[]; lines?: string[] } = {}) {
  const lines = options.lines;
  const destination = lines
    ? {
        write(chunk: string) {
          lines.push(chunk);
        },
      }
    : undefined;
  return createAgentResponder({
    db,
    llm,
    logger: createLogger({ logLevel: lines ? 'debug' : 'silent' }, destination),
    now: () => NOW,
    ...(options.tools ? { tools: options.tools } : {}),
  });
}

function reply(
  f: Fixture,
  pending: ReceivedMessage[],
  script: ScriptStep[],
  options: { tools?: AgentTool<unknown>[]; lines?: string[] } = {},
) {
  const { llm, requests } = scriptedLlm(script);
  const respond = build(llm, options);
  const result = respond(
    { tenantId: f.tenantId, conversationId: f.conversationId, customerId: f.customerId, messages: pending },
    { signal },
  );
  return { result, requests };
}

const textOf = (message: LlmMessage) => ('text' in message ? message.text : message.role);
const conversationOf = (messagesSent: LlmMessage[]) => messagesSent.map((m) => `${m.role}: ${textOf(m)}`);

const runsOf = (f: Fixture) =>
  db.select().from(agentRuns).where(eq(agentRuns.conversationId, f.conversationId)).orderBy(asc(agentRuns.createdAt));

describe('createAgentResponder: lo que lee el modelo', () => {
  it('lleva el historial en orden, con los salientes como asistente, y después los mensajes pendientes', async () => {
    const f = await setup();
    await addInbound(f, { text: 'Hola', at: hoursAgo(3) });
    await addOutbound(f, { type: 'text', body: 'Hola, soy Luna.' }, hoursAgo(3));
    await addInbound(f, { text: 'Quiero un semi', at: hoursAgo(2) });
    await addOutbound(
      f,
      {
        type: 'buttons',
        body: '¿Cuál?',
        buttons: [
          { id: 'servicio:a', title: 'Semi manos' },
          { id: 'servicio:b', title: 'Semi pies' },
        ],
      },
      hoursAgo(2),
    );
    const pending = await pendingTexts(f, 'el de manos', 'para el viernes');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual([
      'user: Hola',
      'assistant: Hola, soy Luna.',
      'user: Quiero un semi',
      'assistant: ¿Cuál?\n[Botones: Semi manos | Semi pies]',
      'user: el de manos',
      'user: para el viernes',
    ]);
  });

  it('no repite los pendientes y deja afuera los que llegaron después y todavía no se procesan', async () => {
    const f = await setup();
    await addInbound(f, { text: 'Antes', at: hoursAgo(1) });
    const pending = await pendingTexts(f, 'Pendiente');
    // Llegó mientras se armaba la vuelta: es de la próxima.
    await addInbound(f, { text: 'Llegó recién', at: new Date(NOW.getTime() - 500), processed: false });

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual(['user: Antes', 'user: Pendiente']);
  });

  it('solo mira las últimas 24 horas: lo más viejo no entra', async () => {
    const f = await setup();
    await addInbound(f, { text: 'Hace dos días', at: hoursAgo(48) });
    await addInbound(f, { text: 'Hace 25 horas', at: hoursAgo(25) });
    await addInbound(f, { text: 'Hace 23 horas', at: hoursAgo(23) });
    const pending = await pendingTexts(f, 'Ahora');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual(['user: Hace 23 horas', 'user: Ahora']);
  });

  it('con más de 20 mensajes se queda con los 20 más nuevos, sin perder el orden', async () => {
    const f = await setup();
    for (let index = 0; index < 25; index += 1) {
      await addInbound(f, { text: `Mensaje ${String(index)}`, at: minutesAgo(200 - index) });
    }
    const pending = await pendingTexts(f, 'Ahora');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    const sent = conversationOf(requests[0]?.messages ?? []);
    expect(sent).toHaveLength(21);
    expect(sent[0]).toBe('user: Mensaje 5');
    expect(sent.at(-2)).toBe('user: Mensaje 24');
    expect(sent.at(-1)).toBe('user: Ahora');
  });

  it('el historial no puede empezar con el asistente: el primer mensaje siempre es de la clienta', async () => {
    const f = await setup();
    await addOutbound(f, { type: 'text', body: 'Te escribió el asistente primero' }, hoursAgo(5));
    await addInbound(f, { text: 'Hola', at: hoursAgo(4) });
    const pending = await pendingTexts(f, 'Ahora');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual(['user: Hola', 'user: Ahora']);
  });

  it('los mensajes que no son texto llegan como marcadores', async () => {
    const f = await setup();
    const audio = await addInbound(f, { type: 'audio', content: { type: 'audio', audio: { id: '1' } }, at: minutesAgo(1), processed: false });
    const image = await addInbound(f, {
      type: 'image',
      content: { type: 'image', image: { id: '2', caption: 'Quiero este' } },
      at: minutesAgo(1),
      processed: false,
    });

    const { result, requests } = reply(f, [audio, image], [finalAnswer('Dale')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual(['user: [Audio]', 'user: [Imagen] «Quiero este»']);
  });
});

describe('createAgentResponder: conversación nueva y contexto de la vuelta (5.1)', () => {
  it('sin ningún saliente en las últimas 24 horas, la conversación es nueva', async () => {
    const f = await setup();
    await addOutbound(f, { type: 'text', body: 'Hola, soy Luna.' }, hoursAgo(30));
    const pending = await pendingTexts(f, 'Hola');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    expect(requests[0]?.turnContext).toContain('Conversación nueva: sí');
  });

  it('con un saliente de hace menos de 24 horas ya no lo es', async () => {
    const f = await setup();
    await addOutbound(f, { type: 'text', body: 'Hola, soy Luna.' }, hoursAgo(23));
    const pending = await pendingTexts(f, 'Hola');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    expect(requests[0]?.turnContext).toContain('Conversación nueva: no');
  });

  it('el contexto lleva la fecha y hora de Mendoza, el nombre de la clienta y el prompt del negocio', async () => {
    const f = await setup('Caro');
    const pending = await pendingTexts(f, 'Hola');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    expect(requests[0]?.turnContext).toContain('lunes 5/10/2026 10:00');
    expect(requests[0]?.turnContext).toContain('Nombre de la clienta: Caro');
    expect(requests[0]?.system).toContain('Luna');
    expect(requests[0]?.system).toContain('Estética');
  });

  it('sin nombre usa el nombre de perfil de WhatsApp', async () => {
    const f = await setup();
    await db.update(customers).set({ whatsappProfileName: 'Caro 🌸' }).where(eq(customers.id, f.customerId));
    const pending = await pendingTexts(f, 'Hola');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    expect(requests[0]?.turnContext).toContain('Nombre de la clienta: Caro 🌸');
  });

  it('las herramientas reciben el negocio y la clienta del servidor, y la hora inyectada', async () => {
    const f = await setup();
    const seen: ToolContext[] = [];
    const spy: AgentTool<unknown> = {
      name: 'buscar_servicios',
      description: 'Espía.',
      input: z.object({}),
      run: (_input, ctx) => {
        seen.push(ctx);
        return Promise.resolve({ content: { ok: true }, options: [] });
      },
    };
    const pending = await pendingTexts(f, 'Hola');

    const { result } = reply(f, pending, [callTools([{ name: 'buscar_servicios' }]), finalAnswer('Listo')], { tools: [spy] });
    await result;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tenantId: f.tenantId,
      customerId: f.customerId,
      conversationId: f.conversationId,
      now: NOW,
      timeZone: 'America/Argentina/Mendoza',
      signal,
    });
  });
});

describe('createAgentResponder: qué opciones eligió la clienta, para las herramientas que cambian turnos (6.4)', () => {
  const tuesday = at('2026-10-06', '09:00');
  const wednesday = at('2026-10-07', '09:00');

  /** Corre una vuelta con una herramienta espía y devuelve lo que ella vio como elegido. */
  async function chosenSeenByTools(f: Fixture, pending: ReceivedMessage[]): Promise<ReadonlySet<string>> {
    const seen: ToolContext[] = [];
    const spy: AgentTool<unknown> = {
      name: 'buscar_servicios',
      description: 'Espía.',
      input: z.object({}),
      run: (_input, ctx) => {
        seen.push(ctx);
        return Promise.resolve({ content: { ok: true }, options: [] });
      },
    };
    const { result } = reply(f, pending, [callTools([{ name: 'buscar_servicios' }]), finalAnswer('Listo')], { tools: [spy] });
    await result;
    return seen[0]?.chosenOptionIds ?? new Set(['la herramienta no corrió']);
  }

  const choiceMessage = (f: Fixture, id: string, when: Date, processed: boolean) =>
    addInbound(f, { type: 'interactive', content: interactiveReply(id, 'un botón'), at: when, processed });

  it('la elección de esta vuelta cuenta', async () => {
    const f = await setup();
    const slot = choiceIds.slot(f.semi, f.mica, tuesday);
    const pending = [await choiceMessage(f, slot, minutesAgo(1), false)];

    expect(await chosenSeenByTools(f, pending)).toEqual(new Set([slot]));
  });

  it('la de un mensaje anterior de las últimas 24 horas también cuenta (pidió el nombre después de elegir)', async () => {
    const f = await setup();
    const slot = choiceIds.slot(f.semi, f.mica, tuesday);
    await choiceMessage(f, slot, hoursAgo(23), true);
    const pending = await pendingTexts(f, 'Caro Pérez');

    expect(await chosenSeenByTools(f, pending)).toEqual(new Set([slot]));
  });

  it('suma las de la vuelta y las del historial, y cada una es un horario distinto', async () => {
    const f = await setup();
    const before = choiceIds.slot(f.semi, f.mica, tuesday);
    const now = choiceIds.slot(f.semi, f.mica, wednesday);
    await choiceMessage(f, before, hoursAgo(2), true);
    const pending = [await choiceMessage(f, now, minutesAgo(1), false)];

    expect(await chosenSeenByTools(f, pending)).toEqual(new Set([before, now]));
  });

  it('una elección de hace más de 24 horas no cuenta', async () => {
    const f = await setup();
    await choiceMessage(f, choiceIds.slot(f.semi, f.mica, tuesday), hoursAgo(25), true);
    const pending = await pendingTexts(f, 'Hola');

    expect(await chosenSeenByTools(f, pending)).toEqual(new Set());
  });

  it('cuenta aunque el historial que ve el modelo (20 mensajes) ya no la incluya', async () => {
    const f = await setup();
    const slot = choiceIds.slot(f.semi, f.mica, tuesday);
    await choiceMessage(f, slot, hoursAgo(10), true);
    for (let index = 0; index < 22; index += 1) {
      await addInbound(f, { text: `mensaje ${String(index)}`, at: minutesAgo(590 - index) });
    }
    const pending = await pendingTexts(f, 'Hola');

    expect(await chosenSeenByTools(f, pending)).toEqual(new Set([slot]));
  });

  it('no cuentan los mensajes de texto, ni lo que escribe la clienta aunque parezca un id', async () => {
    const f = await setup();
    const slot = choiceIds.slot(f.semi, f.mica, tuesday);
    await addInbound(f, { text: slot, at: hoursAgo(1) });
    const pending = await pendingTexts(f, `reservame ${slot}`);

    expect(await chosenSeenByTools(f, pending)).toEqual(new Set());
  });

  it('no cuentan las elecciones de otra conversación ni las que todavía no se procesaron y no son de esta vuelta', async () => {
    const f = await setup();
    const other = await setup();
    await choiceMessage(other, choiceIds.slot(other.semi, other.mica, tuesday), hoursAgo(1), true);
    // Llegó mientras se armaba la vuelta: es de la próxima.
    await choiceMessage(f, choiceIds.slot(f.semi, f.mica, wednesday), new Date(NOW.getTime() - 500), false);
    const pending = await pendingTexts(f, 'Hola');

    expect(await chosenSeenByTools(f, pending)).toEqual(new Set());
  });
});

describe('createAgentResponder: las elecciones con botones se resuelven antes de llegar al modelo (5.3)', () => {
  it('un horario que sigue libre: el modelo no ve el título del botón, ve la elección ya resuelta', async () => {
    const f = await setup();
    const tuesday = at('2026-10-06', '09:00');
    const choice = await addInbound(f, {
      type: 'interactive',
      content: interactiveReply(choiceIds.slot(f.semi, f.mica, tuesday), 'mar 6/10 9:00'),
      at: minutesAgo(1),
      processed: false,
    });

    const { result, requests } = reply(f, [choice], [finalAnswer('Dale')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual([`user: ${CHOICE_MARKER}`]);
    expect(requests[0]?.turnContext).toContain(
      `Eligió el horario martes 6/10 9:00 con Mica para Esmaltado semipermanente (60 min), horario_id=${choiceIds.slot(f.semi, f.mica, tuesday)}; sigue libre.`,
    );
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('mar 6/10 9:00');
  });

  it('un horario que otra clienta tomó mientras tanto llega como "ya no está libre"', async () => {
    const f = await setup();
    const monday = at('2026-10-05', '15:00');
    const booked = await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: f.customerId,
      serviceId: f.semi,
      professionalId: f.mica,
      start: monday,
      actor: 'assistant',
      // La reserva provisoria retiene el horario una hora: tiene que seguir vigente a las 10:00.
      now: minutesAgo(5),
    });
    expect(booked.ok).toBe(true);
    const choice = await addInbound(f, {
      type: 'interactive',
      content: interactiveReply(choiceIds.slot(f.semi, f.mica, monday), 'lun 5/10 15:00'),
      at: minutesAgo(1),
      processed: false,
    });

    const { result, requests } = reply(f, [choice], [finalAnswer('Ese ya no está')]);
    await result;

    expect(requests[0]?.turnContext).toContain('lunes 5/10 15:00 con Mica');
    expect(requests[0]?.turnContext).toContain('ya no está libre');
  });

  it('un id de otro negocio o armado a mano llega como opción que ya no es válida', async () => {
    const f = await setup();
    const other = await setup();
    const choice = await addInbound(f, {
      type: 'interactive',
      content: interactiveReply(choiceIds.service(other.semi), 'Semipermanente'),
      at: minutesAgo(1),
      processed: false,
    });
    const forged = await addInbound(f, {
      type: 'interactive',
      content: interactiveReply('descuento:100', 'Cien por ciento'),
      at: minutesAgo(1),
      processed: false,
    });

    const { result, requests } = reply(f, [choice, forged], [finalAnswer('Dale')]);
    await result;

    const context = requests[0]?.turnContext ?? '';
    expect(context).toMatch(/1\. Eligió una opción que ya no es válida/);
    expect(context).toMatch(/2\. Eligió una opción que ya no es válida/);
    expect(context).not.toContain('Semipermanente');
  });

  it('"ver más horarios" le da al modelo los datos para volver a consultar', async () => {
    const f = await setup();
    const after = at('2026-10-06', '12:00');
    const choice = await addInbound(f, {
      type: 'interactive',
      content: interactiveReply(choiceIds.more(f.semi, null, after), 'Ver más horarios'),
      at: minutesAgo(1),
      processed: false,
    });

    const { result, requests } = reply(f, [choice], [finalAnswer('Dale')]);
    await result;

    expect(requests[0]?.turnContext).toContain(`servicio_id=${f.semi}`);
    expect(requests[0]?.turnContext).toContain(`despues_de=${after.toISOString()}`);
  });

  it('en el historial, una elección vieja se ve con el título que tocó y el id de la opción elegida', async () => {
    // Así, si después de elegir el horario hay que pedir el nombre, el modelo todavía tiene el id para reservar.
    const f = await setup();
    const slotId = choiceIds.slot(f.semi, f.mica, at('2026-10-06', '15:30'));
    await addInbound(f, {
      type: 'interactive',
      content: interactiveReply(slotId, 'mar 6/10 15:30'),
      at: hoursAgo(1),
    });
    const pending = await pendingTexts(f, 'Caro Pérez');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual([
      `user: ${CHOICE_MARKER} «mar 6/10 15:30» (opción elegida: ${slotId})`,
      'user: Caro Pérez',
    ]);
  });

  it('en el historial, un id que no se reconoce no se le muestra al modelo: solo el título', async () => {
    const f = await setup();
    await addInbound(f, {
      type: 'interactive',
      content: interactiveReply('servicio:viejo', 'Semi manos'),
      at: hoursAgo(1),
    });
    const pending = await pendingTexts(f, 'Ahora');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual([`user: ${CHOICE_MARKER} «Semi manos»`, 'user: Ahora']);
  });

  it('el contexto de la vuelta dice si la clienta tiene nombre para el turno', async () => {
    const named = await setup('Caro Pérez');
    const anonymous = await setup(null);

    const withName = reply(named, await pendingTexts(named, 'Hola'), [finalAnswer('Dale')]);
    await withName.result;
    const withoutName = reply(anonymous, await pendingTexts(anonymous, 'Hola'), [finalAnswer('Dale')]);
    await withoutName.result;

    expect(withName.requests[0]?.turnContext).toMatch(/Nombre para el turno: Caro Pérez \(ya está cargado/);
    expect(withoutName.requests[0]?.turnContext).toMatch(/Nombre para el turno: no está cargado/);
  });
});

describe('createAgentResponder: la respuesta y el registro en agent_runs (7.2)', () => {
  it('devuelve el mensaje del agente con las opciones que ofreció una herramienta real', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, '¿Cuánto sale el semi?');
    const script: ScriptStep[] = [
      callTools([{ name: 'buscar_servicios', input: {} }]),
      finalAnswer('Tengo estos:', [choiceIds.service(f.semi), choiceIds.service(f.sculpted)]),
    ];

    const { result } = reply(f, pending, script);
    const message = await result;

    expect(message).toEqual({
      type: 'buttons',
      body: 'Tengo estos:',
      buttons: [
        { id: choiceIds.service(f.semi), title: 'Esmaltado…' },
        { id: choiceIds.service(f.sculpted), title: 'Uñas esculpidas' },
      ],
    });
  });

  it('guarda una fila con el modelo, los tokens, las herramientas y cómo terminó, sin contenido', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, 'Mi secreto es el pan de ajo');
    const script: ScriptStep[] = [
      callTools([{ name: 'buscar_servicios', input: { texto: 'semi' } }], {
        usage: { inputTokens: 1_000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 900 },
      }),
      finalAnswer('Listo', [], { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0 } }),
    ];

    const { result } = reply(f, pending, script);
    await result;

    const [run, ...rest] = await runsOf(f);
    expect(rest).toEqual([]);
    expect(run).toMatchObject({
      tenantId: f.tenantId,
      conversationId: f.conversationId,
      model: 'modelo-de-prueba',
      llmCalls: 2,
      inputTokens: 1_100,
      outputTokens: 60,
      cacheReadTokens: 900,
      cacheWriteTokens: 900,
      toolCalls: ['buscar_servicios'],
      outcome: 'replied',
    });
    expect(run?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(run)).not.toContain('pan de ajo');
  });

  it('si el modelo no da una respuesta usable, responde la frase fija y lo registra', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, 'Hola');

    const { result } = reply(f, pending, [finalAnswer('No', [], { stopReason: 'refusal' })]);

    expect(await result).toEqual({ type: 'text', body: FALLBACK_REPLY_TEXT });
    expect((await runsOf(f))[0]?.outcome).toBe('fallback_refusal');
  });

  it('si el proveedor falla, el error sube para reintentar la tarea y no queda ninguna fila', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, 'Hola');
    const llm: LlmClient = { complete: () => Promise.reject(new Error('529 overloaded')) };
    const respond = build(llm);

    await expect(
      respond(
        { tenantId: f.tenantId, conversationId: f.conversationId, customerId: f.customerId, messages: pending },
        { signal },
      ),
    ).rejects.toThrow('529 overloaded');
    expect(await runsOf(f)).toEqual([]);
  });

  it('el log de info lleva solo métricas: nunca el contenido de los mensajes (10.1)', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, 'Mi contraseña es zanahoria');
    const lines: string[] = [];

    const { result } = reply(f, pending, [finalAnswer('Respuesta con papa frita')], { lines });
    await result;

    const output = lines.join('');
    expect(output).toContain(f.tenantId);
    expect(output).toContain(f.conversationId);
    expect(output).not.toContain('zanahoria');
    expect(output).not.toContain('papa frita');
  });
});

describe('createAgentResponder: límite de mensajes por hora (9.1)', () => {
  async function flood(f: Fixture, count: number, from = minutesAgo(30)) {
    for (let index = 0; index < count; index += 1) {
      await addInbound(f, { text: `Spam ${String(index)}`, at: new Date(from.getTime() + index * 1_000) });
    }
  }

  it('el límite es de 30 mensajes por hora', () => {
    expect(MAX_INBOUND_MESSAGES_PER_HOUR).toBe(30);
  });

  it('con 31 mensajes en la última hora no llama al modelo, no contesta y lo registra', async () => {
    const f = await setup();
    await flood(f, 30);
    const pending = await pendingTexts(f, 'Mensaje número 31 con contenido secreto');
    const lines: string[] = [];

    const { result, requests } = reply(f, pending, [finalAnswer('No debería llamarse')], { lines });

    expect(await result).toBeNull();
    expect(requests).toEqual([]);
    const [run, ...rest] = await runsOf(f);
    expect(rest).toEqual([]);
    expect(run).toMatchObject({ outcome: 'rate_limited', model: null, llmCalls: 0, toolCalls: [] });
    const output = lines.join('');
    expect(output).toContain('"level":40');
    expect(output).not.toContain('secreto');
    expect(output).not.toContain('Spam');
  });

  it('con exactamente 30 mensajes en la hora todavía contesta', async () => {
    const f = await setup();
    await flood(f, 29);
    const pending = await pendingTexts(f, 'El número 30');

    const { result, requests } = reply(f, pending, [finalAnswer('Dale')]);

    expect(await result).toEqual({ type: 'text', body: 'Dale' });
    expect(requests).toHaveLength(1);
  });

  it('los mensajes de hace más de una hora no cuentan', async () => {
    const f = await setup();
    await flood(f, 40, hoursAgo(2));
    const pending = await pendingTexts(f, 'Hola');

    const { result } = reply(f, pending, [finalAnswer('Dale')]);

    expect(await result).toEqual({ type: 'text', body: 'Dale' });
  });

  it('el límite es por clienta: el spam de otro negocio no la afecta', async () => {
    const f = await setup();
    const spammer = await setup();
    await flood(spammer, 40);
    const pending = await pendingTexts(f, 'Hola');

    const { result } = reply(f, pending, [finalAnswer('Dale')]);

    expect(await result).toEqual({ type: 'text', body: 'Dale' });
  });
});

describe('createAgentResponder: el segundo intento fallido deriva a una persona (4.8, 8.5)', () => {
  const refusal = () => finalAnswer('No', [], { stopReason: 'refusal' });

  /** Una vuelta anterior de esa conversación, ya registrada. */
  async function addPreviousRun(
    f: Fixture,
    input: { outcome: (typeof agentRuns.$inferInsert)['outcome']; at: Date; called?: boolean },
  ) {
    const called = input.called ?? true;
    await db.insert(agentRuns).values({
      tenantId: f.tenantId,
      conversationId: f.conversationId,
      model: called ? 'modelo-de-prueba' : null,
      llmCalls: called ? 1 : 0,
      outcome: input.outcome,
      createdAt: input.at,
    });
  }

  const handoffsOf = (f: Fixture) => db.select().from(handoffs).where(eq(handoffs.conversationId, f.conversationId));
  const conversationOf = async (f: Fixture) =>
    single(await db.select().from(conversations).where(eq(conversations.id, f.conversationId)));

  it('el primer fallo responde la frase fija y no deriva', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, 'asdf');

    const { result } = reply(f, pending, [refusal()]);

    expect(await result).toEqual({ type: 'text', body: FALLBACK_REPLY_TEXT });
    expect(await handoffsOf(f)).toEqual([]);
    expect(await conversationOf(f)).toMatchObject({ assistantStatus: 'active' });
  });

  it.each(['fallback_refusal', 'fallback_max_tokens', 'fallback_invalid_output', 'fallback_unfulfilled_handoff'] as const)(
    'si la vuelta anterior terminó en %s y esta también falla, deriva con "no entiende" y la clienta recibe el texto fijo',
    async (previous) => {
      const f = await setup();
      await addPreviousRun(f, { outcome: previous, at: minutesAgo(5) });
      const pending = await pendingTexts(f, 'asdf');

      const { result } = reply(f, pending, [refusal()]);

      expect(await result).toEqual({ type: 'text', body: notUnderstoodHandoffText('lo antes posible') });
      expect(await handoffsOf(f)).toEqual([
        expect.objectContaining({
          reason: 'not_understood',
          summary: 'El asistente no entendió dos veces seguidas',
          status: 'open',
        }),
      ]);
      expect(await conversationOf(f)).toMatchObject({
        assistantStatus: 'paused',
        pausedUntil: new Date(NOW.getTime() + 12 * 60 * 60 * 1_000),
      });
      expect((await runsOf(f)).map((run) => run.outcome)).toEqual([previous, 'handoff_not_understood']);
    },
  );

  it('prometer una persona sin derivar, aun después del aviso, es un fallo: frase fija, registrado con las dos llamadas, y no deriva', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, 'estoy muy enojada con el turno de ayer');

    const { result, requests } = reply(f, pending, [
      promisedHandoffAnswer('Te paso el reclamo a una persona del equipo.'),
      promisedHandoffAnswer('Ya le aviso a una persona del equipo.'),
    ]);

    expect(await result).toEqual({ type: 'text', body: FALLBACK_REPLY_TEXT });
    expect(requests).toHaveLength(2);
    expect(await handoffsOf(f)).toEqual([]);
    expect(await runsOf(f)).toEqual([
      expect.objectContaining({ outcome: 'fallback_unfulfilled_handoff', llmCalls: 2, toolCalls: [] }),
    ]);
  });

  it('el segundo intento seguido que promete una persona sin derivar cuenta como fallo y deriva el código', async () => {
    const f = await setup();
    await addPreviousRun(f, { outcome: 'fallback_refusal', at: minutesAgo(5) });
    const pending = await pendingTexts(f, 'estoy muy enojada con el turno de ayer');

    const { result } = reply(f, pending, [
      promisedHandoffAnswer('Te paso el reclamo a una persona del equipo.'),
      promisedHandoffAnswer('Ya le aviso a una persona del equipo.'),
    ]);

    expect(await result).toEqual({ type: 'text', body: notUnderstoodHandoffText('lo antes posible') });
    expect(await handoffsOf(f)).toEqual([expect.objectContaining({ reason: 'not_understood', status: 'open' })]);
    expect((await runsOf(f)).map((run) => run.outcome)).toEqual(['fallback_refusal', 'handoff_not_understood']);
  });

  it('si en la corrección el modelo deriva con la herramienta de verdad, la derivación queda registrada y la respuesta sale', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, 'estoy muy enojada con el turno de ayer');

    const { result } = reply(f, pending, [
      promisedHandoffAnswer('Te paso el reclamo a una persona del equipo.'),
      callTools([
        {
          name: 'derivar_a_persona',
          input: { motivo: 'queja', resumen: 'Reclamo por el turno de ayer' },
        },
      ]),
      promisedHandoffAnswer('Una persona del equipo te responde por acá lo antes posible.'),
    ]);

    expect(await result).toEqual({ type: 'text', body: 'Una persona del equipo te responde por acá lo antes posible.' });
    expect(await handoffsOf(f)).toEqual([expect.objectContaining({ reason: 'complaint', status: 'open' })]);
    expect(await runsOf(f)).toEqual([
      expect.objectContaining({ outcome: 'replied', llmCalls: 3, toolCalls: ['derivar_a_persona'] }),
    ]);
    expect(await conversationOf(f)).toMatchObject({ assistantStatus: 'paused' });
  });

  it('el texto fijo dice cuándo responde una persona, según el horario del negocio', async () => {
    const f = await setup(null, {
      settings: { humanAttentionHours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })) },
    });
    await addPreviousRun(f, { outcome: 'fallback_refusal', at: minutesAgo(5) });
    const pending = await pendingTexts(f, 'asdf');

    const { result } = reply(f, pending, [refusal()]);

    expect(await result).toEqual({
      type: 'text',
      body: 'Perdón, no te estoy entendiendo. Le paso tu consulta a una persona del equipo, que te va a responder por acá en este horario.',
    });
  });

  it('si la vuelta anterior contestó bien, el fallo es el primero de la racha y no deriva', async () => {
    const f = await setup();
    await addPreviousRun(f, { outcome: 'fallback_refusal', at: minutesAgo(30) });
    await addPreviousRun(f, { outcome: 'replied', at: minutesAgo(10) });
    const pending = await pendingTexts(f, 'asdf');

    const { result } = reply(f, pending, [refusal()]);

    expect(await result).toEqual({ type: 'text', body: FALLBACK_REPLY_TEXT });
    expect(await handoffsOf(f)).toEqual([]);
  });

  it('una vuelta anterior de hace más de 24 horas no cuenta', async () => {
    const f = await setup();
    await addPreviousRun(f, { outcome: 'fallback_refusal', at: hoursAgo(25) });
    const pending = await pendingTexts(f, 'asdf');

    const { result } = reply(f, pending, [refusal()]);

    expect(await result).toEqual({ type: 'text', body: FALLBACK_REPLY_TEXT });
    expect(await handoffsOf(f)).toEqual([]);
  });

  it('una vuelta que no llamó al modelo (límite por hora) no corta la racha', async () => {
    const f = await setup();
    await addPreviousRun(f, { outcome: 'fallback_refusal', at: minutesAgo(20) });
    await addPreviousRun(f, { outcome: 'rate_limited', at: minutesAgo(10), called: false });
    const pending = await pendingTexts(f, 'asdf');

    const { result } = reply(f, pending, [refusal()]);

    expect(await result).toEqual({ type: 'text', body: notUnderstoodHandoffText('lo antes posible') });
    expect(await handoffsOf(f)).toHaveLength(1);
  });

  it('las vueltas de otra conversación no cuentan', async () => {
    const f = await setup();
    const other = await setup();
    await addPreviousRun(other, { outcome: 'fallback_refusal', at: minutesAgo(5) });
    const pending = await pendingTexts(f, 'asdf');

    const { result } = reply(f, pending, [refusal()]);

    expect(await result).toEqual({ type: 'text', body: FALLBACK_REPLY_TEXT });
    expect(await handoffsOf(f)).toEqual([]);
  });
});

describe('createAgentResponder: turnos con las herramientas reales (H8)', () => {
  const handoffsOf = (f: Fixture) => db.select().from(handoffs).where(eq(handoffs.conversationId, f.conversationId));
  const statusOf = async (appointmentId: string) =>
    single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId))).status;

  it('reservar después de pedir el nombre: el id del horario sale del historial y la reserva queda hecha', async () => {
    const f = await setup(null);
    const slotId = choiceIds.slot(f.semi, f.mica, at('2026-10-06', '15:30'));
    await addInbound(f, { type: 'interactive', content: interactiveReply(slotId, 'mar 6/10 15:30'), at: minutesAgo(3) });
    await addOutbound(f, { type: 'text', body: '¡Genial! ¿A nombre de quién lo anoto?' }, minutesAgo(2));
    const pending = await pendingTexts(f, 'Caro Pérez');

    // El modelo copia del historial el id de la opción elegida y reserva con el nombre.
    const bookFromHistory: ScriptStep = (request) => {
      const text = request.messages.map(textOf).join('\n');
      const horario_id = /opción elegida: (\S+)\)/.exec(text)?.[1];
      return callTools([{ name: 'crear_reserva', input: { horario_id, nombre: 'Caro Pérez' } }]);
    };
    const { result } = reply(f, pending, [bookFromHistory, finalAnswer('Listo Caro, te guardo el martes 6/10 a las 15:30 con Mica.')]);
    await result;

    const [appointment] = await db.select().from(appointments).where(eq(appointments.customerId, f.customerId));
    expect(appointment).toMatchObject({ status: 'PENDING_DEPOSIT', serviceId: f.semi, professionalId: f.mica });
    expect(appointment?.timeRange.start).toEqual(at('2026-10-06', '15:30'));
    const [customer] = await db.select({ name: customers.name }).from(customers).where(eq(customers.id, f.customerId));
    expect(customer?.name).toBe('Caro Pérez');
  });

  it('cancelar: primero ofrece «Sí, cancelar» sin tocar el turno; al tocarlo, lo cancela', async () => {
    const f = await setup('Caro Pérez');
    const booked = await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: f.customerId,
      serviceId: f.semi,
      professionalId: f.mica,
      start: at('2026-10-07', '10:00'),
      actor: 'assistant',
      now: NOW,
    });
    if (!booked.ok) throw new Error(booked.reason);
    const turnoId = choiceIds.appointment(booked.appointmentId);

    // Vuelta 1: la clienta pide cancelar; el modelo lista, pide la confirmación y ofrece el botón.
    const first = reply(f, await pendingTexts(f, 'tengo que cancelar mi turno'), [
      callTools([{ name: 'listar_turnos_de_la_clienta' }]),
      callTools([{ name: 'cancelar_turno', input: { turno_id: turnoId, confirmada: false } }]),
      finalAnswer('Tenés el miércoles 7/10 a las 10:00. ¿Lo cancelo?', [choiceIds.cancel(booked.appointmentId)]),
    ]);
    const asked = await first.result;

    expect(asked).toEqual({
      type: 'buttons',
      body: 'Tenés el miércoles 7/10 a las 10:00. ¿Lo cancelo?',
      buttons: [{ id: choiceIds.cancel(booked.appointmentId), title: 'Sí, cancelar' }],
    });
    expect(await statusOf(booked.appointmentId)).toBe('PENDING_DEPOSIT');

    // Vuelta 2: la clienta toca el botón; el contexto le dice al modelo que confirmó y cancela.
    const tap = await addInbound(f, {
      type: 'interactive',
      content: interactiveReply(choiceIds.cancel(booked.appointmentId), 'Sí, cancelar'),
      at: new Date(NOW.getTime() - 1_000),
      processed: false,
    });
    const second = reply(f, [tap], [
      callTools([{ name: 'cancelar_turno', input: { turno_id: turnoId, confirmada: true } }]),
      finalAnswer('Listo, quedó cancelado.'),
    ]);
    await second.result;

    expect(second.requests[0]?.turnContext).toContain(`Confirmó que quiere cancelar el turno del miércoles 7/10 10:00`);
    expect(second.requests[0]?.turnContext).toContain(`turno_id=${turnoId}`);
    expect(await statusOf(booked.appointmentId)).toBe('CANCELLED_BY_CUSTOMER');
  });

  it('cancelar fuera de plazo y derivar en la misma vuelta deja una sola derivación y el turno intacto', async () => {
    const f = await setup('Caro Pérez', { settings: { depositRequirement: 'never' } });
    const booked = await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: f.customerId,
      serviceId: f.semi,
      professionalId: f.mica,
      start: at('2026-10-06', '09:00'),
      actor: 'assistant',
      now: NOW,
    });
    if (!booked.ok) throw new Error(booked.reason);

    // Lunes 5/10 a las 10:00 y el turno es el martes a las 9:00: faltan 23 horas.
    const { result } = reply(f, await pendingTexts(f, 'cancelame el turno de mañana'), [
      callTools([
        { name: 'cancelar_turno', input: { turno_id: booked.appointmentId, confirmada: true } },
        { name: 'derivar_a_persona', input: { motivo: 'excepcion', resumen: 'Quiere cancelar fuera de plazo' } },
      ]),
      finalAnswer('Como faltan menos de 24 horas, lo ve una persona del equipo.'),
    ]);
    await result;

    expect(await statusOf(booked.appointmentId)).toBe('CONFIRMED');
    expect(await handoffsOf(f)).toHaveLength(1);
  });
});
