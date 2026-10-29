import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAgentResponder,
  MAX_INBOUND_MESSAGES_PER_HOUR,
  severalPendingReceiptsText,
} from '../../src/modules/conversation/agent/agent-responder.js';
import { FALLBACK_REPLY_TEXT, notUnderstoodHandoffText } from '../../src/modules/conversation/agent/agent.js';
import type { LlmClient, LlmMessage } from '../../src/modules/conversation/agent/llm-client.js';
import { chosenSlotNotice } from '../../src/modules/conversation/agent/agent.js';
import {
  CHOICE_MARKER,
  CONVERSATION_STARTED_BY_NOTICE,
  SYSTEM_NOTICE_LABELS,
} from '../../src/modules/conversation/agent/message-text.js';
import type { ReceivedMessage } from '../../src/modules/conversation/processing.js';
import { agentRuns, conversations, handoffs, messages } from '../../src/modules/conversation/schema.js';
import { choiceIds } from '../../src/modules/conversation/tools/choice-ids.js';
import type { AgentTool, ToolContext } from '../../src/modules/conversation/tools/tool.js';
import { customers } from '../../src/modules/customers/schema.js';
import { notifications } from '../../src/modules/notifications/schema.js';
import { bookAppointment, changeAppointmentStatus } from '../../src/modules/scheduling/booking.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import { tenantSettings } from '../../src/modules/tenants/schema.js';
import type { FreeFormMessage } from '../../src/modules/whatsapp/outgoing.js';
import { renderTemplate, templateMessage } from '../../src/modules/whatsapp/templates.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { callTools, finalAnswer, handoffAnswer, scriptedLlm, type ScriptStep } from '../support/fake-llm.js';
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

async function addOutbound(f: Fixture, message: FreeFormMessage, sentAt: Date) {
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

  describe('después de una derivación (4.8): una elección de antes no sirve para reservar', () => {
    const resumeAt = (f: Fixture, when: Date) =>
      db.update(conversations).set({ resumedAt: when }).where(eq(conversations.id, f.conversationId));

    it('la elegida antes de la reanudación no cuenta, aunque sea de las últimas 24 horas', async () => {
      const f = await setup();
      await choiceMessage(f, choiceIds.slot(f.semi, f.mica, tuesday), hoursAgo(5), true);
      await resumeAt(f, hoursAgo(1));
      const pending = await pendingTexts(f, 'Caro Pérez');

      expect(await chosenSeenByTools(f, pending)).toEqual(new Set());
    });

    it('la elegida después de la reanudación sí cuenta, y la anterior sigue sin contar', async () => {
      const f = await setup();
      const before = choiceIds.slot(f.semi, f.mica, tuesday);
      const after = choiceIds.slot(f.semi, f.mica, wednesday);
      await choiceMessage(f, before, hoursAgo(5), true);
      await resumeAt(f, hoursAgo(2));
      await choiceMessage(f, after, hoursAgo(1), true);
      const pending = await pendingTexts(f, 'Caro Pérez');

      expect(await chosenSeenByTools(f, pending)).toEqual(new Set([after]));
    });

    it('con una reanudación de hace más de 24 horas, manda la ventana de 24 horas', async () => {
      const f = await setup();
      const old = choiceIds.slot(f.semi, f.mica, tuesday);
      const recent = choiceIds.slot(f.semi, f.mica, wednesday);
      await choiceMessage(f, old, hoursAgo(25), true);
      await choiceMessage(f, recent, hoursAgo(23), true);
      await resumeAt(f, hoursAgo(48));
      const pending = await pendingTexts(f, 'Caro Pérez');

      expect(await chosenSeenByTools(f, pending)).toEqual(new Set([recent]));
    });

    it('la elección de esta vuelta cuenta aunque sea anterior a la reanudación', async () => {
      const f = await setup();
      const slot = choiceIds.slot(f.semi, f.mica, tuesday);
      // Llegó unos segundos antes de que el asistente se reanudara para procesarla.
      const pending = [await choiceMessage(f, slot, minutesAgo(1), false)];
      await resumeAt(f, new Date(NOW.getTime() - 30_000));

      expect(await chosenSeenByTools(f, pending)).toEqual(new Set([slot]));
    });
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

describe('createAgentResponder: si la clienta eligió un horario libre, la respuesta tiene que reservarlo (6.4)', () => {
  // Prueba manual de H9: tocó un horario libre y el modelo contestó «no quedó reservado» sin llamar a crear_reserva.
  const tuesday = at('2026-10-06', '09:00');
  const tap = (f: Fixture, id: string) =>
    addInbound(f, { type: 'interactive', content: interactiveReply(id, 'mar 6/10 9:00'), at: minutesAgo(1), processed: false });
  const lastNote = (request: { messages: LlmMessage[] } | undefined) => request?.messages.at(-1);

  it('con nombre y el horario libre, si no llama a crear_reserva se lo marca con ese horario_id', async () => {
    const f = await setup('Caro Pérez');
    const slotId = choiceIds.slot(f.semi, f.mica, tuesday);

    const { result, requests } = reply(f, [await tap(f, slotId)], [finalAnswer('No quedó reservado'), finalAnswer('Perdón')]);
    await result;

    expect(requests).toHaveLength(2);
    expect(lastNote(requests[1])).toEqual({
      role: 'system_note',
      text: chosenSlotNotice({ tool: 'crear_reserva', slotId }),
    });
  });

  it('sin nombre cargado no: primero tiene que preguntárselo', async () => {
    const f = await setup(null);

    const { result, requests } = reply(f, [await tap(f, choiceIds.slot(f.semi, f.mica, tuesday))], [finalAnswer('¿A nombre de quién?')]);
    await result;

    expect(requests).toHaveLength(1);
  });

  it('si el horario ya no está libre no: no hay nada que reservar', async () => {
    const f = await setup('Caro Pérez');
    const monday = at('2026-10-05', '15:00');
    const booked = await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: f.customerId,
      serviceId: f.semi,
      professionalId: f.mica,
      start: monday,
      actor: 'assistant',
      now: minutesAgo(5),
    });
    expect(booked.ok).toBe(true);

    const { result, requests } = reply(f, [await tap(f, choiceIds.slot(f.semi, f.mica, monday))], [finalAnswer('Ese ya no está')]);
    await result;

    expect(requests).toHaveLength(1);
  });

  it('un horario para mover su turno pide reprogramar_turno, aunque no tenga nombre', async () => {
    const f = await setup(null);
    const booked = await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: f.customerId,
      serviceId: f.semi,
      professionalId: f.mica,
      start: at('2026-10-05', '15:00'),
      actor: 'assistant',
      now: minutesAgo(5),
    });
    if (!booked.ok) throw new Error('no se pudo reservar');
    const slotId = choiceIds.reschedule(booked.appointmentId, tuesday);

    const { result, requests } = reply(f, [await tap(f, slotId)], [finalAnswer('¿Lo pasamos?'), finalAnswer('Perdón')]);
    await result;

    expect(lastNote(requests[1])).toEqual({
      role: 'system_note',
      text: chosenSlotNotice({ tool: 'reprogramar_turno', slotId }),
    });
  });

  it('una elección de antes (historial) no cuenta: solo la de esta vuelta', async () => {
    const f = await setup('Caro Pérez');
    await addInbound(f, {
      type: 'interactive',
      content: interactiveReply(choiceIds.slot(f.semi, f.mica, tuesday), 'mar 6/10 9:00'),
      at: minutesAgo(10),
    });

    const { result, requests } = reply(f, await pendingTexts(f, '¿Qué turnos tengo?'), [finalAnswer('No tenés turnos')]);
    await result;

    expect(requests).toHaveLength(1);
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

  it.each(['fallback_refusal', 'fallback_max_tokens', 'fallback_invalid_output', 'fallback_unconfirmed_change'] as const)(
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

  describe('un cambio de turno que ninguna herramienta confirmó (6.4)', () => {
    const CLAIM = 'Listo, lo paso al miércoles 14/10 a las 15:30 con Mica. Ya te quedó reprogramado.';

    it('la clienta recibe el texto fijo, nunca la confirmación falsa, y la vuelta queda con su propio motivo', async () => {
      const f = await setup();
      const pending = await pendingTexts(f, 'dale, el miércoles');

      const { result } = reply(f, pending, [finalAnswer(CLAIM), finalAnswer(CLAIM)]);

      expect(await result).toEqual({ type: 'text', body: FALLBACK_REPLY_TEXT });
      expect((await runsOf(f)).map((run) => run.outcome)).toEqual(['fallback_unconfirmed_change']);
      expect(await handoffsOf(f)).toEqual([]);
      expect(await conversationOf(f)).toMatchObject({ assistantStatus: 'active' });
    });

    it('cuenta como intento fallido: si la vuelta anterior también falló, deriva con "no entiende"', async () => {
      const f = await setup();
      await addPreviousRun(f, { outcome: 'fallback_invalid_output', at: minutesAgo(5) });
      const pending = await pendingTexts(f, 'dale, el miércoles');

      const { result } = reply(f, pending, [finalAnswer(CLAIM), finalAnswer(CLAIM)]);

      expect(await result).toEqual({ type: 'text', body: notUnderstoodHandoffText('lo antes posible') });
      expect(await handoffsOf(f)).toEqual([expect.objectContaining({ reason: 'not_understood', status: 'open' })]);
      expect((await runsOf(f)).map((run) => run.outcome)).toEqual(['fallback_invalid_output', 'handoff_not_understood']);
    });

    it('si el modelo se corrige, la clienta recibe la respuesta corregida y la vuelta queda replied', async () => {
      const f = await setup();
      const pending = await pendingTexts(f, 'dale, el miércoles');

      const { result } = reply(f, pending, [finalAnswer(CLAIM), finalAnswer('Todavía no lo moví: tocá el horario que querés.')]);

      expect(await result).toEqual({ type: 'text', body: 'Todavía no lo moví: tocá el horario que querés.' });
      expect((await runsOf(f)).map((run) => run.outcome)).toEqual(['replied']);
    });
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

describe('createAgentResponder: el comprobante de la seña lo reconoce el código (4.5, 5.3)', () => {
  const statusOf = async (appointmentId: string) =>
    single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId))).status;

  async function pendingDeposit(f: Fixture, start = at('2026-10-06', '15:30')) {
    const booked = await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: f.customerId,
      serviceId: f.semi,
      professionalId: f.mica,
      start,
      actor: 'assistant',
      now: minutesAgo(10),
    });
    if (!booked.ok || !booked.deposit) throw new Error('La reserva de prueba no quedó pendiente de seña');
    return booked.appointmentId;
  }

  const image = (f: Fixture, id: string, caption?: string) =>
    addInbound(f, {
      type: 'image',
      content: { type: 'image', image: { id, mime_type: 'image/jpeg', ...(caption ? { caption } : {}) } },
      at: minutesAgo(1),
      processed: false,
    });

  it('con una seña pendiente: registra el comprobante y el modelo lo ve como tal, con el hecho en el contexto', async () => {
    const f = await setup('Caro Pérez');
    const appointmentId = await pendingDeposit(f);

    const { result, requests } = reply(f, [await image(f, 'media-1', 'ahí va')], [finalAnswer('¡Gracias! Ya lo recibí.')]);
    await result;

    expect(await statusOf(appointmentId)).toBe('DEPOSIT_REVIEW');
    expect(conversationOf(requests[0]?.messages ?? [])).toEqual(['user: [Comprobante de la seña] «ahí va»']);
    expect(requests[0]?.turnContext).toContain('comprobante de la transferencia de la seña de su turno del martes 6/10 15:30');
    expect(requests[0]?.turnContext).toMatch(/No digas que la seña ni el turno quedaron confirmados/);
  });

  it('dos fotos seguidas del mismo comprobante: las dos son el comprobante', async () => {
    const f = await setup('Caro Pérez');
    await pendingDeposit(f);
    const first = await image(f, 'media-1');
    const second = await image(f, 'media-2');

    const { result, requests } = reply(f, [first, second], [finalAnswer('¡Gracias!')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual([
      'user: [Comprobante de la seña]',
      'user: [Comprobante de la seña]',
    ]);
  });

  it('sin seña pendiente, una imagen es una imagen: la decide el modelo como siempre', async () => {
    const f = await setup('Caro Pérez');

    const { result, requests } = reply(f, [await image(f, 'media-1')], [finalAnswer('Dale')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual(['user: [Imagen]']);
    expect(requests[0]?.turnContext).not.toMatch(/comprobante/i);
  });

  it('con dos señas pendientes no adivina: deriva con «pago» y un texto fijo, sin llamar al modelo', async () => {
    const f = await setup('Caro Pérez', {
      settings: { humanAttentionHours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })) },
    });
    const first = await pendingDeposit(f);
    await pendingDeposit(f, at('2026-10-07', '15:30'));

    const { result, requests } = reply(f, [await image(f, 'media-1')], []);
    const answer = await result;

    expect(requests).toEqual([]);
    expect(answer).toEqual({ type: 'text', body: severalPendingReceiptsText('en este horario') });
    expect(await statusOf(first)).toBe('PENDING_DEPOSIT');
    expect(await db.select().from(handoffs).where(eq(handoffs.conversationId, f.conversationId))).toMatchObject([
      { reason: 'payment_issue', status: 'open' },
    ]);
    // Una fila por respuesta (7.2), aunque no se llamó al modelo.
    expect(await runsOf(f)).toMatchObject([{ outcome: 'handoff_payment_issue', model: null, llmCalls: 0 }]);
  });

  it('en el historial, un aviso que mandó el código se ve como aviso del sistema, no como algo que dijo el asistente', async () => {
    // Lo encontró la prueba manual: después de «¡Seña recibida! Tu turno quedó confirmado» (lo manda el código cuando
    // la dueña toca «Recibida»), a un «hola» el asistente contestó «te aclaro: tu turno todavía no está confirmado».
    // Creía haberlo escrito él, contra la regla de no dar la seña por confirmada.
    const f = await setup('Caro Pérez');
    const confirmed = { type: 'text' as const, body: '¡Seña recibida! Tu turno quedó confirmado: martes 6/10 15:30.' };
    const whatsappMessageId = `wamid.${randomUUID()}`;
    await addInbound(f, { text: 'hola', at: minutesAgo(30) });
    await db.insert(messages).values({
      tenantId: f.tenantId,
      conversationId: f.conversationId,
      direction: 'outbound',
      type: 'text',
      content: confirmed,
      whatsappMessageId,
      occurredAt: minutesAgo(20),
    });
    await db.insert(notifications).values({
      tenantId: f.tenantId,
      recipient: 'customer',
      kind: 'deposit_confirmed',
      customerId: f.customerId,
      message: confirmed,
      status: 'sent',
      whatsappMessageId,
      sentAt: minutesAgo(20),
    });

    const { result, requests } = reply(f, await pendingTexts(f, 'hola'), [finalAnswer('¡Hola!')]);
    await result;

    expect(conversationOf(requests[0]?.messages ?? [])).toEqual([
      'user: hola',
      `assistant: ${SYSTEM_NOTICE_LABELS.deposit_confirmed} ${confirmed.body}`,
      'user: hola',
    ]);
    expect(SYSTEM_NOTICE_LABELS.deposit_confirmed).toMatch(/no lo escribiste vos/);
  });

  it.each([
    [
      'appointment_reminder',
      templateMessage('recordatorio_turno', {
        params: { servicio: 'Esmaltado semipermanente', profesional: 'Mica', fecha_hora: 'martes 6/10 15:30' },
        buttonPayloads: ['recordatorio:a:confirmar', 'recordatorio:a:reprogramar', 'recordatorio:a:cancelar'],
      }),
    ],
    [
      'reservation_expired',
      templateMessage('reserva_vencida', { params: { servicio: 'Esmaltado semipermanente', fecha_hora: 'martes 6/10 15:30' } }),
    ],
  ] as const)('en el historial, el %s (una plantilla) se ve con su texto, como aviso del sistema (H10)', async (kind, template) => {
    const f = await setup('Caro Pérez');
    const appointmentId = await pendingDeposit(f);
    const whatsappMessageId = `wamid.${randomUUID()}`;
    await db.insert(messages).values({
      tenantId: f.tenantId,
      conversationId: f.conversationId,
      direction: 'outbound',
      type: 'template',
      content: template,
      whatsappMessageId,
      occurredAt: minutesAgo(20),
    });
    await db.insert(notifications).values({
      tenantId: f.tenantId,
      recipient: 'customer',
      kind,
      customerId: f.customerId,
      appointmentId,
      appointmentStart: at('2026-10-06', '15:30'),
      message: template,
      status: 'sent',
      whatsappMessageId,
      sentAt: minutesAgo(20),
    });

    const { result, requests } = reply(f, await pendingTexts(f, 'hola'), [finalAnswer('¡Hola!')]);
    await result;

    // La clienta no escribió en las últimas 24 horas: el aviso abre el historial y no se descarta, aunque la API
    // exija empezar con ella. Sin esto, a un «no voy a poder ir» el modelo no sabía de qué recordatorio hablaba.
    expect(conversationOf(requests[0]?.messages ?? [])).toEqual([
      `user: ${CONVERSATION_STARTED_BY_NOTICE}`,
      `assistant: ${SYSTEM_NOTICE_LABELS[kind]} ${renderTemplate(template) ?? ''}`,
      'user: hola',
    ]);
    expect(SYSTEM_NOTICE_LABELS[kind]).toMatch(/no lo escribiste vos/);
  });

  it('en el historial, el comprobante de antes se sigue viendo como comprobante (no como imagen para derivar)', async () => {
    const f = await setup('Caro Pérez');
    await pendingDeposit(f);
    const { result } = reply(f, [await image(f, 'media-1')], [finalAnswer('¡Gracias! Ya lo recibí.')]);
    await result;
    await db.update(messages).set({ processedAt: minutesAgo(1) }).where(eq(messages.conversationId, f.conversationId));

    const next = reply(f, await pendingTexts(f, '¿ya lo vieron?'), [finalAnswer('Todavía no.')]);
    await next.result;

    expect(conversationOf(next.requests[0]?.messages ?? [])).toEqual([
      'user: [Comprobante de la seña]',
      'user: ¿ya lo vieron?',
    ]);
  });
});

describe('createAgentResponder: turnos con las herramientas reales (H8)', () => {
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
    const { result } = reply(f, pending, [bookFromHistory, finalAnswer('Listo Caro, te guardo el martes 6/10 a las 15:30 con Mica. Transferí la seña al alias estetica.prueba y mandame el comprobante.')]);
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

  it('reprogramar: la clienta toca el horario y, aunque el modelo pida crear_reserva, el turno se mueve y no queda un turno nuevo (decisión 28)', async () => {
    const f = await setup('Caro Pérez', { settings: { depositRequirement: 'never' } });
    const booked = await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: f.customerId,
      serviceId: f.semi,
      professionalId: f.mica,
      start: at('2026-10-08', '10:00'),
      actor: 'assistant',
      now: NOW,
    });
    if (!booked.ok) throw new Error(booked.reason);
    // Ofreció horarios para mover el turno y la clienta toca el del viernes 9/10 a las 15:30.
    const slotId = choiceIds.reschedule(booked.appointmentId, at('2026-10-09', '15:30'));
    await addInbound(f, { text: 'puedo pasar mi turno del jueves al viernes?', at: minutesAgo(3) });
    await addOutbound(
      f,
      { type: 'buttons', body: 'El viernes tengo estos horarios:', buttons: [{ id: slotId, title: 'vie 9/10 15:30' }] },
      minutesAgo(2),
    );
    const tap = await addInbound(f, {
      type: 'interactive',
      content: interactiveReply(slotId, 'vie 9/10 15:30'),
      at: new Date(NOW.getTime() - 1_000),
      processed: false,
    });

    // El modelo falla como en las evaluaciones: copia el id a crear_reserva. Con el rechazo, usa reprogramar_turno.
    const { result, requests } = reply(f, [tap], [
      callTools([{ name: 'crear_reserva', input: { horario_id: slotId } }]),
      callTools([{ name: 'reprogramar_turno', input: { horario_id: slotId } }]),
      finalAnswer('Listo, te pasé el turno al viernes 9/10 a las 15:30 con Mica.'),
    ]);
    await result;

    expect(requests[0]?.turnContext).toContain(`horario_id=${slotId}`);
    expect(requests[0]?.turnContext).toContain('llamá a reprogramar_turno con ese horario_id');
    const mine = await db.select().from(appointments).where(eq(appointments.customerId, f.customerId));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: booked.appointmentId, status: 'CONFIRMED' });
    expect(mine[0]?.timeRange.start).toEqual(at('2026-10-09', '15:30'));
  });
});

describe('createAgentResponder: la respuesta que deriva a una persona (4.8, decisión 27)', () => {
  const handoffsOf = (f: Fixture) => db.select().from(handoffs).where(eq(handoffs.conversationId, f.conversationId));
  const conversationRow = async (f: Fixture) =>
    single(await db.select().from(conversations).where(eq(conversations.id, f.conversationId)));
  const WEEKDAYS_9_TO_18 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' }));

  const complaint = { motivo: 'queja', resumen: 'Reclamo por la atención del turno de ayer' };

  it('registra la derivación, pausa el asistente y devuelve el texto del modelo', async () => {
    const f = await setup('Caro Pérez');
    const pending = await pendingTexts(f, 'estoy muy enojada con el turno de ayer');

    const { result, requests } = reply(f, pending, [
      handoffAnswer('Lamento lo que pasó. Una persona del equipo te responde por acá lo antes posible.', complaint),
    ]);

    expect(await result).toEqual({
      type: 'text',
      body: 'Lamento lo que pasó. Una persona del equipo te responde por acá lo antes posible.',
    });
    expect(requests).toHaveLength(1);
    expect(await handoffsOf(f)).toEqual([
      expect.objectContaining({ reason: 'complaint', summary: complaint.resumen, status: 'open' }),
    ]);
    expect(await conversationRow(f)).toMatchObject({
      assistantStatus: 'paused',
      pausedUntil: new Date(NOW.getTime() + 12 * 60 * 60 * 1_000),
    });
    expect(await runsOf(f)).toEqual([expect.objectContaining({ outcome: 'replied', llmCalls: 1 })]);
  });

  it('cada motivo del modelo se guarda con el motivo de la base que le corresponde', async () => {
    const reasons = [
      ['pedido_de_la_clienta', 'customer_request'],
      ['imagen', 'unsupported_media'],
      ['consulta_previa', 'requires_consultation'],
      ['fuera_de_catalogo', 'off_catalog'],
      ['excepcion', 'policy_exception'],
      ['no_entiende', 'not_understood'],
    ] as const;
    for (const [motivo, reason] of reasons) {
      const f = await setup();
      const pending = await pendingTexts(f, 'quiero hablar con alguien');

      const { result } = reply(f, pending, [
        handoffAnswer('Te paso con una persona del equipo.', { motivo, resumen: 'Necesita que la atienda una persona' }),
      ]);
      await result;

      expect(await handoffsOf(f), motivo).toEqual([expect.objectContaining({ reason })]);
    }
  });

  it('con un tema sensible guarda el resumen fijo y descarta el del modelo (regla 9)', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, 'estoy embarazada, ¿puedo hacerme el lifting?');

    const { result } = reply(f, pending, [
      handoffAnswer('Eso lo ve una persona del equipo.', { motivo: 'tema_sensible', resumen: 'Embarazada de 8 semanas' }),
    ]);
    await result;

    const [handoff] = await handoffsOf(f);
    expect(handoff).toMatchObject({ reason: 'sensitive_topic', summary: 'Tema sensible: ver la conversación' });
    expect(JSON.stringify(handoff)).not.toContain('Embarazada');
  });

  it('sin derivar no hay derivación ni pausa', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, 'hola');

    const { result } = reply(f, pending, [finalAnswer('¡Hola! ¿En qué te ayudo?')]);
    await result;

    expect(await handoffsOf(f)).toEqual([]);
    expect(await conversationRow(f)).toMatchObject({ assistantStatus: 'active', pausedUntil: null });
  });

  it('un resumen de relleno no deriva: la clienta recibe la frase fija y el asistente sigue activo', async () => {
    const f = await setup();
    const pending = await pendingTexts(f, 'hola');

    const { result } = reply(f, pending, [
      handoffAnswer('Te paso con una persona.', { motivo: 'queja', resumen: 'placeholder' }),
    ]);

    expect(await result).toEqual({ type: 'text', body: FALLBACK_REPLY_TEXT });
    expect(await handoffsOf(f)).toEqual([]);
    expect(await conversationRow(f)).toMatchObject({ assistantStatus: 'active' });
    expect(await runsOf(f)).toEqual([expect.objectContaining({ outcome: 'fallback_invalid_output' })]);
  });

  it('si una herramienta ya derivó por la política y el modelo también pide derivar, queda una sola derivación', async () => {
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
      callTools([{ name: 'cancelar_turno', input: { turno_id: booked.appointmentId, confirmada: true } }]),
      handoffAnswer('Como faltan menos de 24 horas, lo ve una persona del equipo.', {
        motivo: 'excepcion',
        resumen: 'Quiere cancelar fuera de plazo',
      }),
    ]);
    await result;

    const derived = await handoffsOf(f);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({ reason: 'policy_exception', status: 'open' });
  });

  describe('cuándo responde una persona va en el contexto de la vuelta, no en el prompt', () => {
    const whenLine = (context: string | undefined) =>
      /- Si derivás a una persona, le responde (.*?): escribilo/.exec(context ?? '')?.[1];

    it('sin horario de atención cargado: lo antes posible', async () => {
      const f = await setup();
      const { result, requests } = reply(f, await pendingTexts(f, 'hola'), [finalAnswer('Hola')]);
      await result;

      expect(whenLine(requests[0]?.turnContext)).toBe('lo antes posible');
    });

    it('ahora dentro del horario de atención: en este horario', async () => {
      // Lunes 10:00.
      const f = await setup(null, { settings: { humanAttentionHours: WEEKDAYS_9_TO_18 } });
      const { result, requests } = reply(f, await pendingTexts(f, 'hola'), [finalAnswer('Hola')]);
      await result;

      expect(whenLine(requests[0]?.turnContext)).toBe('en este horario');
    });

    it('fuera del horario: el próximo inicio, escrito por el código', async () => {
      // Hoy lunes no hay atención: abre el martes.
      const f = await setup(null, { settings: { humanAttentionHours: [{ weekday: 2, start: '09:00', end: '18:00' }] } });
      const { result, requests } = reply(f, await pendingTexts(f, 'hola'), [finalAnswer('Hola')]);
      await result;

      expect(whenLine(requests[0]?.turnContext)).toBe('el martes 6/10 a las 9:00');
    });

    it('el prompt del sistema es idéntico entre vueltas del mismo negocio aunque cambie cuándo responde una persona', async () => {
      const f = await setup(null, { settings: { humanAttentionHours: WEEKDAYS_9_TO_18 } });
      const first = reply(f, await pendingTexts(f, 'hola'), [finalAnswer('Hola')]);
      await first.result;
      await db
        .update(tenantSettings)
        .set({ humanAttentionHours: [{ weekday: 2, start: '09:00', end: '18:00' }] })
        .where(eq(tenantSettings.tenantId, f.tenantId));
      const second = reply(f, await pendingTexts(f, 'chau'), [finalAnswer('Chau')]);
      await second.result;

      expect(whenLine(first.requests[0]?.turnContext)).toBe('en este horario');
      expect(whenLine(second.requests[0]?.turnContext)).toBe('el martes 6/10 a las 9:00');
      expect(second.requests[0]?.system).toBe(first.requests[0]?.system);
      expect(first.requests[0]?.system).not.toContain('6/10');
    });
  });
});

describe('createAgentResponder: el asistente se reanudó después de una derivación (4.8)', () => {
  const RESUMED_LINE_PATTERN = /El asistente se reanudó después de una derivación/;
  const resumedAt = (f: Fixture, when: Date) =>
    db.update(conversations).set({ resumedAt: when }).where(eq(conversations.id, f.conversationId));

  /** Corre una vuelta con un mensaje pendiente y devuelve lo que vio el modelo. */
  async function firstRequest(f: Fixture) {
    const { result, requests } = reply(f, await pendingTexts(f, 'tenés turno para semi el lunes a la tarde?'), [
      finalAnswer('Dale'),
    ]);
    await result;
    return requests[0];
  }

  describe('la línea del contexto de la vuelta', () => {
    it('si se reanudó y el asistente todavía no le escribió desde entonces, el contexto se lo dice al modelo', async () => {
      const f = await setup();
      await addOutbound(f, { type: 'text', body: 'Una persona te va a responder.' }, hoursAgo(3));
      await resumedAt(f, hoursAgo(1));

      const request = await firstRequest(f);

      expect(request?.turnContext).toMatch(RESUMED_LINE_PATTERN);
      expect(request?.turnContext).toContain('Atendé solo lo que pide ahora, sin volver a derivar por lo anterior.');
    });

    it('en una conversación que nunca se pausó no hay línea', async () => {
      const f = await setup();
      await addOutbound(f, { type: 'text', body: 'Hola, soy Luna.' }, hoursAgo(3));

      const request = await firstRequest(f);

      expect(request?.turnContext).not.toMatch(RESUMED_LINE_PATTERN);
    });

    it('cuando el asistente ya le escribió después de reanudarse, la línea deja de aparecer', async () => {
      const f = await setup();
      await addOutbound(f, { type: 'text', body: 'Una persona te va a responder.' }, hoursAgo(3));
      await resumedAt(f, hoursAgo(1));
      await addInbound(f, { text: 'tenés turno para semi?', at: minutesAgo(50) });
      await addOutbound(f, { type: 'text', body: 'Sí, ¿qué día?' }, minutesAgo(49));

      const request = await firstRequest(f);

      expect(request?.turnContext).not.toMatch(RESUMED_LINE_PATTERN);
    });

    it('el aviso de la derivación, anterior a la reanudación, no cuenta como "ya le escribió"', async () => {
      const f = await setup();
      await addOutbound(f, { type: 'text', body: 'Una persona te va a responder.' }, minutesAgo(61));
      await resumedAt(f, minutesAgo(60));

      const request = await firstRequest(f);

      expect(request?.turnContext).toMatch(RESUMED_LINE_PATTERN);
    });

    it('lo que escribió otra conversación no cuenta: la línea sigue en esta', async () => {
      const f = await setup();
      const other = await setup();
      await resumedAt(f, hoursAgo(1));
      await addOutbound(other, { type: 'text', body: 'Hola' }, minutesAgo(30));

      const request = await firstRequest(f);

      expect(request?.turnContext).toMatch(RESUMED_LINE_PATTERN);
    });

    it('el prompt del sistema es idéntico con o sin la línea: lo que cambia va en el contexto de la vuelta', async () => {
      const f = await setup();
      const before = await firstRequest(f);
      await resumedAt(f, hoursAgo(1));
      const after = await firstRequest(f);

      expect(before?.turnContext).not.toMatch(RESUMED_LINE_PATTERN);
      expect(after?.turnContext).toMatch(RESUMED_LINE_PATTERN);
      expect(after?.system).toBe(before?.system);
      expect(after?.system).not.toMatch(RESUMED_LINE_PATTERN);
    });
  });
});

describe('createAgentResponder: el historial arranca en la reanudación (4.8)', () => {
  const resumedAt = (f: Fixture, when: Date) =>
    db.update(conversations).set({ resumedAt: when }).where(eq(conversations.id, f.conversationId));
  const NEW_REQUEST = 'tenés turno para semi el lunes a la tarde?';

  async function sentToTheModel(f: Fixture, ...texts: string[]) {
    const { result, requests } = reply(f, await pendingTexts(f, ...(texts.length > 0 ? texts : [NEW_REQUEST])), [
      finalAnswer('Dale'),
    ]);
    await result;
    return requests[0];
  }

  it('el ciclo de la prueba manual: lo hablado antes de la derivación y durante la pausa no llega al modelo', async () => {
    const f = await setup();
    await addInbound(f, { text: 'quiero hablar con una persona', at: hoursAgo(6) });
    await addOutbound(
      f,
      { type: 'text', body: 'Ya le pasé tu pedido a una persona del equipo.' },
      hoursAgo(6),
    );
    // Durante la pausa: se marcaron procesados sin contestar.
    await addInbound(f, { text: 'Hola', at: hoursAgo(3) });
    await addInbound(f, { text: 'que paso con la persona', at: hoursAgo(2) });
    await resumedAt(f, minutesAgo(1));

    const request = await sentToTheModel(f);

    expect(conversationOf(request?.messages ?? [])).toEqual([`user: ${NEW_REQUEST}`]);
    expect(request?.turnContext).toMatch(/El asistente se reanudó después de una derivación/);
    // Nada de lo anterior se filtra por otro lado.
    expect(JSON.stringify(request?.messages)).not.toMatch(/persona/);
  });

  it('lo que pasó después de reanudarse sí lo ve, en orden', async () => {
    const f = await setup();
    await addInbound(f, { text: 'que paso con la persona', at: hoursAgo(2) });
    await resumedAt(f, minutesAgo(30));
    await addInbound(f, { text: 'tenés turno para semi?', at: minutesAgo(20) });
    await addOutbound(f, { type: 'text', body: 'Sí, ¿qué día?' }, minutesAgo(19));

    const request = await sentToTheModel(f, 'el lunes');

    expect(conversationOf(request?.messages ?? [])).toEqual([
      'user: tenés turno para semi?',
      'assistant: Sí, ¿qué día?',
      'user: el lunes',
    ]);
  });

  it('sin fecha de reanudación, el historial es el de siempre (las últimas 24 horas)', async () => {
    const f = await setup();
    await addInbound(f, { text: 'Hace 25 horas', at: hoursAgo(25) });
    await addInbound(f, { text: 'Hace 3 horas', at: hoursAgo(3) });
    await addInbound(f, { text: 'Hace 2 horas', at: hoursAgo(2) });

    const request = await sentToTheModel(f);

    expect(conversationOf(request?.messages ?? [])).toEqual([
      'user: Hace 3 horas',
      'user: Hace 2 horas',
      `user: ${NEW_REQUEST}`,
    ]);
  });

  it('con una reanudación de hace más de 24 horas, manda la ventana de 24 horas', async () => {
    const f = await setup();
    await addInbound(f, { text: 'Hace 40 horas', at: hoursAgo(40) });
    await addInbound(f, { text: 'Hace 25 horas', at: hoursAgo(25) });
    await addInbound(f, { text: 'Hace 23 horas', at: hoursAgo(23) });
    await resumedAt(f, hoursAgo(48));

    const request = await sentToTheModel(f);

    expect(conversationOf(request?.messages ?? [])).toEqual(['user: Hace 23 horas', `user: ${NEW_REQUEST}`]);
  });

  it('con una reanudación de hace menos de 24 horas, manda la reanudación', async () => {
    const f = await setup();
    await addInbound(f, { text: 'Hace 23 horas', at: hoursAgo(23) });
    await addInbound(f, { text: 'Hace 9 horas', at: hoursAgo(9) });
    await resumedAt(f, hoursAgo(10));

    const request = await sentToTheModel(f);

    expect(conversationOf(request?.messages ?? [])).toEqual(['user: Hace 9 horas', `user: ${NEW_REQUEST}`]);
  });

  it('el tope de 20 mensajes sigue valiendo dentro de lo que ve desde la reanudación', async () => {
    const f = await setup();
    await resumedAt(f, hoursAgo(10));
    for (let index = 0; index < 25; index += 1) {
      await addInbound(f, { text: `Mensaje ${String(index)}`, at: minutesAgo(500 - index) });
    }

    const request = await sentToTheModel(f);

    const sent = conversationOf(request?.messages ?? []);
    expect(sent).toHaveLength(21);
    expect(sent[0]).toBe('user: Mensaje 5');
  });

  it('la reanudación de otra conversación no recorta esta', async () => {
    const f = await setup();
    const other = await setup();
    await addInbound(f, { text: 'Hace 3 horas', at: hoursAgo(3) });
    await resumedAt(other, minutesAgo(1));

    const request = await sentToTheModel(f);

    expect(conversationOf(request?.messages ?? [])).toEqual(['user: Hace 3 horas', `user: ${NEW_REQUEST}`]);
  });

  it('"conversación nueva" no cambia: sigue contando los salientes de las últimas 24 horas', async () => {
    const reused = await setup();
    await addOutbound(reused, { type: 'text', body: 'Una persona te va a responder.' }, hoursAgo(3));
    await resumedAt(reused, hoursAgo(1));
    const stale = await setup();
    await addOutbound(stale, { type: 'text', body: 'Una persona te va a responder.' }, hoursAgo(30));
    await resumedAt(stale, hoursAgo(1));

    expect((await sentToTheModel(reused))?.turnContext).toMatch(/Conversación nueva: no/);
    expect((await sentToTheModel(stale))?.turnContext).toMatch(/Conversación nueva: sí/);
  });
});

describe('createAgentResponder: los botones del recordatorio (4.7, H10)', () => {
  async function confirmedAppointment(f: Fixture, start = at('2026-10-06', '15:30')) {
    const booked = await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: f.customerId,
      serviceId: f.semi,
      professionalId: f.mica,
      start,
      actor: 'assistant',
      now: hoursAgo(30),
    });
    if (!booked.ok) throw new Error(booked.reason);
    return booked.appointmentId;
  }

  const tapReminder = (f: Fixture, appointmentId: string, code: 'confirmar' | 'reprogramar' | 'cancelar', text: string) =>
    addInbound(f, {
      type: 'button',
      content: { type: 'button', button: { payload: `recordatorio:${appointmentId}:${code}`, text } },
      at: minutesAgo(0.1),
      processed: false,
    });

  const statusOfAppointment = async (appointmentId: string) =>
    single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId))).status;

  const attendanceEvents = async (appointmentId: string) =>
    (await db.select().from(appointmentEvents).where(eq(appointmentEvents.appointmentId, appointmentId))).filter(
      (event) => event.kind === 'attendance_confirmed',
    );

  it('«Confirmo» lo registra el código antes de llamar al modelo, y el contexto se lo dice', async () => {
    const f = await setup('Caro Pérez', { settings: { depositRequirement: 'never' } });
    const appointmentId = await confirmedAppointment(f);

    const { result, requests } = reply(f, [await tapReminder(f, appointmentId, 'confirmar', 'Confirmo')], [
      finalAnswer('¡Gracias, Caro! Te esperamos el martes.'),
    ]);
    await result;

    expect(await attendanceEvents(appointmentId)).toHaveLength(1);
    expect(requests[0]?.turnContext).toContain('Tocó «Confirmo» en el recordatorio de su turno del martes 6/10 15:30');
    expect(requests[0]?.turnContext).toContain('el sistema ya registró que viene');
  });

  it('«Confirmo» sobre un turno cancelado no registra nada y el contexto lo dice', async () => {
    const f = await setup('Caro Pérez', { settings: { depositRequirement: 'never' } });
    const appointmentId = await confirmedAppointment(f);
    await changeAppointmentStatus(db, {
      tenantId: f.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: hoursAgo(2),
    });

    const { result, requests } = reply(f, [await tapReminder(f, appointmentId, 'confirmar', 'Confirmo')], [
      finalAnswer('Ese turno ya estaba cancelado.'),
    ]);
    await result;

    expect(await attendanceEvents(appointmentId)).toEqual([]);
    expect(requests[0]?.turnContext).toContain('no se registró nada');
  });

  it('«Cancelar» lo contesta el código: pide la confirmación con «Sí, cancelar», sin llamar al modelo', async () => {
    // Prueba manual de H10: el modelo lo contestaba sin llamar a cancelar_turno (sin el botón), aun con el aviso.
    const f = await setup('Caro Pérez', { settings: { depositRequirement: 'never' } });
    const appointmentId = await confirmedAppointment(f);

    const { result, requests } = reply(f, [await tapReminder(f, appointmentId, 'cancelar', 'Cancelar')], []);
    const answer = await result;

    expect(requests).toEqual([]);
    expect(answer).toEqual({
      type: 'buttons',
      body: '¿Querés cancelar tu turno de Esmaltado semipermanente con Mica del martes 6/10 15:30? Si es así, tocá «Sí, cancelar».',
      buttons: [{ id: choiceIds.cancel(appointmentId), title: 'Sí, cancelar' }],
    });
    expect(await statusOfAppointment(appointmentId)).toBe('CONFIRMED');
    expect(await runsOf(f)).toMatchObject([{ outcome: 'reminder_button', model: null, llmCalls: 0 }]);
  });

  it('«Cancelar» fuera de plazo: no cancela, deriva y le dice la política con un texto fijo', async () => {
    const f = await setup('Caro Pérez', { settings: { depositRequirement: 'never' } });
    const appointmentId = await confirmedAppointment(f, at('2026-10-05', '17:00'));

    const { result, requests } = reply(f, [await tapReminder(f, appointmentId, 'cancelar', 'Cancelar')], []);
    const answer = await result;

    expect(requests).toEqual([]);
    expect(answer).toMatchObject({ type: 'text' });
    const body = answer?.type === 'text' ? answer.body : '';
    expect(body).toMatch(/^No puedo cancelar tu turno del lunes 5\/10 17:00 porque faltan menos de 24 horas para el turno/);
    expect(body).toContain('Tu turno no cambió.');
    expect(await statusOfAppointment(appointmentId)).toBe('CONFIRMED');
    expect(await db.select().from(handoffs).where(eq(handoffs.conversationId, f.conversationId))).toMatchObject([
      { reason: 'policy_exception', status: 'open' },
    ]);
  });

  it('«Reprogramar» lo contesta el código: pregunta para qué día, sin ofrecer horarios al azar', async () => {
    const f = await setup('Caro Pérez', { settings: { depositRequirement: 'never' } });
    const appointmentId = await confirmedAppointment(f);

    const { result, requests } = reply(f, [await tapReminder(f, appointmentId, 'reprogramar', 'Reprogramar')], []);
    const answer = await result;

    expect(requests).toEqual([]);
    expect(answer).toEqual({
      type: 'text',
      body:
        '¿Para qué día querés pasar tu turno de Esmaltado semipermanente con Mica del martes 6/10 15:30? ' +
        'Decime el día y si preferís a la mañana o a la tarde, y te busco horarios.',
    });
  });

  it('«Reprogramar» fuera de plazo deriva igual que la herramienta, sin preguntar el día', async () => {
    const f = await setup('Caro Pérez', { settings: { depositRequirement: 'never' } });
    const appointmentId = await confirmedAppointment(f, at('2026-10-05', '17:00'));

    const answer = await reply(f, [await tapReminder(f, appointmentId, 'reprogramar', 'Reprogramar')], []).result;

    expect(answer?.type === 'text' ? answer.body : '').toMatch(/^No puedo reprogramar tu turno del lunes 5\/10 17:00/);
    expect(await db.select().from(handoffs).where(eq(handoffs.conversationId, f.conversationId))).toHaveLength(1);
  });

  it('el botón de un turno que ya no está activo lo dice, sin derivar ni llamar al modelo', async () => {
    const f = await setup('Caro Pérez', { settings: { depositRequirement: 'never' } });
    const appointmentId = await confirmedAppointment(f);
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId, to: 'CANCELLED_BY_CUSTOMER', actor: 'assistant', now: hoursAgo(1) });

    const { result, requests } = reply(f, [await tapReminder(f, appointmentId, 'reprogramar', 'Reprogramar')], []);
    const answer = await result;

    expect(requests).toEqual([]);
    expect(answer).toEqual({
      type: 'text',
      body: 'Tu turno de Esmaltado semipermanente con Mica del martes 6/10 15:30 ya no está activo (cancelado), así que no hay nada para reprogramar.',
    });
    expect(await db.select().from(handoffs).where(eq(handoffs.conversationId, f.conversationId))).toEqual([]);
  });
});
