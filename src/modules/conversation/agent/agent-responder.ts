import { and, count, desc, eq, gt, isNotNull, notInArray, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { professionals } from '../../catalog/schema.js';
import { customers } from '../../customers/schema.js';
import { tenants } from '../../tenants/schema.js';
import type { OutgoingMessage } from '../../whatsapp/outgoing.js';
import { describeWhenHumanReplies, handOff } from '../handoff.js';
import type { ConversationTurn, ReceivedMessage, Responder } from '../processing.js';
import { agentRuns, conversations, messages } from '../schema.js';
import { parseChoiceId } from '../tools/choice-ids.js';
import { resolveChoice, type ResolvedChoice } from '../tools/choices.js';
import { agentTools } from '../tools/index.js';
import type { AgentTool } from '../tools/tool.js';
import { isFallbackOutcome, notUnderstoodHandoffText, runAgent, type AgentRun } from './agent.js';
import type { LlmClient, LlmMessage } from './llm-client.js';
import { describeInbound, outgoingToText, type InboundDescription } from './message-text.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildTurnContext } from './turn-context.js';

/**
 * El `Responder` del worker desde H7 (sección 8.5): arma lo que ve el modelo (historial, contexto
 * de la vuelta, elecciones ya resueltas), corre el agente y registra la vuelta en `agent_runs`.
 * Reemplaza al eco de desarrollo.
 */

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** [S] Límite de mensajes entrantes por hora por clienta, para frenar abusos y costos (9.1). */
export const MAX_INBOUND_MESSAGES_PER_HOUR = 30;
/** [S] Cuánto historial ve el modelo: hasta 20 mensajes de las últimas 24 horas (8.5). */
export const HISTORY_MAX_MESSAGES = 20;
export const HISTORY_WINDOW_MS = DAY_MS;
/** [S] Una conversación es nueva si el asistente no le escribió a la clienta en las últimas 24 horas (5.1). */
export const NEW_CONVERSATION_AFTER_MS = DAY_MS;

/** Lo que ve la dueña cuando el código deriva porque el modelo falló dos veces seguidas (4.8). */
export const NOT_UNDERSTOOD_SUMMARY = 'El asistente no entendió dos veces seguidas';

export interface AgentResponderDependencies {
  db: NodePgDatabase;
  llm: LlmClient;
  logger: Logger;
  /** La hora actual, inyectada (regla 5). */
  now: () => Date;
  /** Por defecto, todas las herramientas del agente. */
  tools?: AgentTool<unknown>[];
  /** Reloj monotónico para medir la latencia (se inyecta en los tests). */
  monotonicNow?: () => number;
}

export function createAgentResponder(deps: AgentResponderDependencies): Responder {
  const { db, llm, now, tools = agentTools } = deps;

  return async (turn: ConversationTurn, { signal }): Promise<OutgoingMessage | null> => {
    const { tenantId, conversationId, customerId } = turn;
    const at = now();
    const logger = deps.logger.child({ tenant_id: tenantId, conversation_id: conversationId });

    // Límite por hora (9.1): se cuenta antes de cualquier otra cosa para no gastar nada.
    const [inbound] = await db
      .select({ total: count() })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, tenantId),
          eq(messages.conversationId, conversationId),
          eq(messages.direction, 'inbound'),
          gt(messages.occurredAt, new Date(at.getTime() - HOUR_MS)),
        ),
      );
    const inboundLastHour = inbound?.total ?? 0;
    if (inboundLastHour > MAX_INBOUND_MESSAGES_PER_HOUR) {
      logger.warn(
        { inboundLastHour, limit: MAX_INBOUND_MESSAGES_PER_HOUR },
        'La clienta pasó el límite de mensajes por hora: no se llama al modelo ni se contesta',
      );
      await db.insert(agentRuns).values({
        tenantId,
        conversationId,
        model: null,
        llmCalls: 0,
        outcome: 'rate_limited',
        createdAt: at,
      });
      return null;
    }

    const [tenant] = await db
      .select({
        name: tenants.name,
        timeZone: tenants.timezone,
        assistantName: tenants.assistantName,
        emojiUsage: tenants.emojiUsage,
        usesVoseo: tenants.usesVoseo,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const [customer] = await db
      .select({
        name: customers.name,
        profileName: customers.whatsappProfileName,
        preferredProfessionalId: customers.preferredProfessionalId,
      })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
    if (!tenant || !customer) throw new Error('No se encontró el negocio o la clienta de la conversación');

    let preferredProfessionalName: string | null = null;
    if (customer.preferredProfessionalId) {
      const [professional] = await db
        .select({ name: professionals.name })
        .from(professionals)
        .where(
          and(eq(professionals.tenantId, tenantId), eq(professionals.id, customer.preferredProfessionalId)),
        );
      preferredProfessionalName = professional?.name ?? null;
    }

    const resumedAt = await loadResumedAt(db, turn);
    const since = historySince(at, resumedAt);
    const history = await loadHistory(db, turn, since);
    const isNewConversation = !(await sentRecently(db, turn, at));
    // Reanudado y sin haberle escrito todavía a la clienta: el modelo empieza de cero y tiene que saber por qué (4.8).
    const resumedAfterHandoff = resumedAt !== null && !(await assistantWroteSince(db, turn, resumedAt));

    // Lo que la clienta tocó en botones o listas se resuelve y se vuelve a validar acá: el modelo
    // recibe la elección ya resuelta y nunca interpreta el título del botón (5.3).
    const choices: ResolvedChoice[] = [];
    const pendingMessages: LlmMessage[] = [];
    const chosenOptionIds = new Set<string>();
    for (const message of turn.messages) {
      const described = describeInbound(message.type, message.content);
      pendingMessages.push({ role: 'user', text: described.text });
      if (described.replyId) {
        chosenOptionIds.add(described.replyId);
        choices.push(await resolveChoice(db, { tenantId, customerId, now: at, timeZone: tenant.timeZone }, described.replyId));
      }
    }
    // Y lo que eligió antes, en las últimas 24 horas y después de reanudarse: crear_reserva y reprogramar_turno solo actúan sobre eso.
    for (const id of await loadEarlierChoiceIds(db, turn, since)) chosenOptionIds.add(id);

    // Se calcula acá y no en el modelo (4.8): si deriva, escribe este texto tal cual en su respuesta.
    const humanReplyWhen = await describeWhenHumanReplies(db, { tenantId, now: at });

    const { message, handoff, run } = await runAgent(
      { llm, tools, logger, ...(deps.monotonicNow ? { monotonicNow: deps.monotonicNow } : {}) },
      {
        system: buildSystemPrompt(tenant),
        turnContext: buildTurnContext({
          now: at,
          timeZone: tenant.timeZone,
          isNewConversation,
          customerName: customer.name ?? customer.profileName,
          bookingName: customer.name,
          preferredProfessionalName,
          humanReplyWhen,
          resumedAfterHandoff,
          choices,
        }),
        history: [...history, ...pendingMessages],
        toolContext: {
          db,
          tenantId,
          customerId,
          conversationId,
          now: at,
          timeZone: tenant.timeZone,
          chosenOptionIds,
          signal,
        },
      },
    );

    // La respuesta pidió derivar (decisión 27): se registra y se pausa el asistente antes de enviarla, las dos
    // cosas juntas en una transacción. Si una herramienta ya derivó en esta vuelta, `handOff` devuelve esa
    // derivación en vez de abrir otra.
    if (handoff) {
      await handOff(db, {
        tenantId,
        conversationId,
        reason: handoff.reason,
        summary: handoff.summary,
        now: at,
      });
    }

    // Segundo intento fallido (4.8, 8.5): lo decide el código, no el modelo. La vuelta anterior se
    // mira antes de registrar esta.
    let reply = message;
    let finalRun = run;
    if (isFallbackOutcome(run.outcome) && (await previousRunFailed(db, turn, at))) {
      const { when } = await handOff(db, {
        tenantId,
        conversationId,
        reason: 'not_understood',
        summary: NOT_UNDERSTOOD_SUMMARY,
        now: at,
      });
      reply = { type: 'text', body: notUnderstoodHandoffText(when) };
      finalRun = { ...run, outcome: 'handoff_not_understood' };
    }

    await saveRun(db, { tenantId, conversationId, run: finalRun, createdAt: at });
    // Solo métricas: ni el contenido de los mensajes ni el de las herramientas (10.1).
    logger.info(
      {
        outcome: finalRun.outcome,
        model: run.model,
        llmCalls: run.llmCalls,
        toolCalls: run.toolCalls,
        latencyMs: run.latencyMs,
        ...run.usage,
        isNewConversation,
      },
      'Respuesta del agente',
    );
    return reply;
  };
}

/**
 * Desde cuándo ve el modelo la conversación: lo más reciente entre la ventana de 24 horas y la
 * reanudación del asistente después de una derivación (4.8). Lo anterior a la reanudación ya lo
 * atendió una persona: si el modelo lo viera, volvería a derivar por un pedido que ya no está
 * pendiente. Vale para el historial y para las opciones elegidas; el instante exacto queda afuera.
 */
function historySince(at: Date, resumedAt: Date | null): Date {
  const windowStart = new Date(at.getTime() - HISTORY_WINDOW_MS);
  return resumedAt !== null && resumedAt.getTime() > windowStart.getTime() ? resumedAt : windowStart;
}

/**
 * Los mensajes anteriores a los pendientes: hasta 20 desde `since`, entrantes ya procesados y
 * salientes. Los entrantes sin procesar son los pendientes (o llegaron después y son de la
 * próxima vuelta): nunca van en el historial, así no se repite ninguno.
 */
async function loadHistory(db: NodePgDatabase, turn: ConversationTurn, since: Date): Promise<LlmMessage[]> {
  const rows = await db
    .select({ direction: messages.direction, type: messages.type, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, turn.tenantId),
        eq(messages.conversationId, turn.conversationId),
        gt(messages.occurredAt, since),
        or(
          eq(messages.direction, 'outbound'),
          and(eq(messages.direction, 'inbound'), isNotNull(messages.processedAt)),
        ),
        notInArray(
          messages.id,
          turn.messages.map((message: ReceivedMessage) => message.id),
        ),
      ),
    )
    .orderBy(desc(messages.occurredAt), desc(messages.createdAt))
    .limit(HISTORY_MAX_MESSAGES);

  const history: LlmMessage[] = [];
  for (const row of rows.reverse()) {
    if (row.direction === 'inbound') {
      const described = describeInbound(row.type, row.content);
      history.push({ role: 'user', text: historyText(described) });
    } else {
      const text = outgoingToText(row.content);
      if (text) history.push({ role: 'assistant', text });
    }
  }
  // La API exige que la conversación empiece con la clienta.
  while (history[0]?.role === 'assistant') history.shift();
  return history;
}

/**
 * Los ids de las opciones que la clienta eligió con un botón o una lista desde `since`, sin contar
 * esta vuelta. Mismo criterio que el historial (entrantes ya procesados, de esta conversación,
 * mismo corte) pero sin tope de mensajes: la ventana es la que manda, no cuántos ve el modelo.
 */
async function loadEarlierChoiceIds(db: NodePgDatabase, turn: ConversationTurn, since: Date): Promise<string[]> {
  const rows = await db
    .select({ type: messages.type, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, turn.tenantId),
        eq(messages.conversationId, turn.conversationId),
        eq(messages.direction, 'inbound'),
        isNotNull(messages.processedAt),
        gt(messages.occurredAt, since),
        notInArray(
          messages.id,
          turn.messages.map((message: ReceivedMessage) => message.id),
        ),
      ),
    );
  return rows.flatMap((row) => describeInbound(row.type, row.content).replyId ?? []);
}

/**
 * Una elección vieja se muestra con el título que tocó y el id de la opción elegida (6.4): así, si
 * después de elegir un horario hay que pedir el nombre, el modelo todavía tiene el id para reservar.
 * Un id que el código no reconoce no se muestra: no le sirve al modelo para nada.
 */
function historyText(described: InboundDescription): string {
  if (!described.replyId) return described.text;
  const title = `${described.text} «${described.replyTitle ?? ''}»`;
  return parseChoiceId(described.replyId) ? `${title} (opción elegida: ${described.replyId})` : title;
}

/**
 * ¿La vuelta anterior de esta conversación también terminó con la frase fija? Cuenta la más
 * reciente de las últimas 24 horas que llamó al modelo: las que no lo llamaron (límite por hora)
 * no dicen nada sobre si el modelo entendió.
 */
async function previousRunFailed(db: NodePgDatabase, turn: ConversationTurn, at: Date): Promise<boolean> {
  const [previous] = await db
    .select({ outcome: agentRuns.outcome })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.tenantId, turn.tenantId),
        eq(agentRuns.conversationId, turn.conversationId),
        isNotNull(agentRuns.model),
        gt(agentRuns.createdAt, new Date(at.getTime() - DAY_MS)),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return previous !== undefined && isFallbackOutcome(previous.outcome);
}

/** Cuándo se reanudó el asistente después de una derivación, o null si esta conversación nunca estuvo pausada (4.8). */
async function loadResumedAt(db: NodePgDatabase, turn: ConversationTurn): Promise<Date | null> {
  const [conversation] = await db
    .select({ resumedAt: conversations.resumedAt })
    .from(conversations)
    .where(and(eq(conversations.tenantId, turn.tenantId), eq(conversations.id, turn.conversationId)));
  return conversation?.resumedAt ?? null;
}

/** ¿El asistente le escribió a la clienta después de `since`? */
async function assistantWroteSince(db: NodePgDatabase, turn: ConversationTurn, since: Date): Promise<boolean> {
  const [written] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, turn.tenantId),
        eq(messages.conversationId, turn.conversationId),
        eq(messages.direction, 'outbound'),
        gt(messages.occurredAt, since),
      ),
    )
    .limit(1);
  return written !== undefined;
}

/** ¿El asistente le escribió a la clienta en las últimas 24 horas? (5.1) */
function sentRecently(db: NodePgDatabase, turn: ConversationTurn, at: Date): Promise<boolean> {
  return assistantWroteSince(db, turn, new Date(at.getTime() - NEW_CONVERSATION_AFTER_MS));
}

async function saveRun(
  db: NodePgDatabase,
  input: { tenantId: string; conversationId: string; run: AgentRun; createdAt: Date },
): Promise<void> {
  const { run } = input;
  await db.insert(agentRuns).values({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    model: run.model,
    llmCalls: run.llmCalls,
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    cacheReadTokens: run.usage.cacheReadTokens,
    cacheWriteTokens: run.usage.cacheWriteTokens,
    toolCalls: run.toolCalls,
    latencyMs: run.latencyMs,
    outcome: run.outcome,
    createdAt: input.createdAt,
  });
}
