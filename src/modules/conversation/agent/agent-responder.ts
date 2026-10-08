import { and, count, desc, eq, gt, isNotNull, notInArray, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { professionals } from '../../catalog/schema.js';
import { customers } from '../../customers/schema.js';
import { tenants } from '../../tenants/schema.js';
import type { OutgoingMessage } from '../../whatsapp/outgoing.js';
import type { ConversationTurn, ReceivedMessage, Responder } from '../processing.js';
import { agentRuns, messages } from '../schema.js';
import { resolveChoice, type ResolvedChoice } from '../tools/choices.js';
import { consultationTools } from '../tools/index.js';
import type { AgentTool } from '../tools/tool.js';
import { runAgent, type AgentRun } from './agent.js';
import type { LlmClient, LlmMessage } from './llm-client.js';
import { describeInbound, outgoingToText } from './message-text.js';
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

export interface AgentResponderDependencies {
  db: NodePgDatabase;
  llm: LlmClient;
  logger: Logger;
  /** La hora actual, inyectada (regla 5). */
  now: () => Date;
  /** Por defecto, las herramientas de consulta de H7. */
  tools?: AgentTool<unknown>[];
  /** Reloj monotónico para medir la latencia (se inyecta en los tests). */
  monotonicNow?: () => number;
}

export function createAgentResponder(deps: AgentResponderDependencies): Responder {
  const { db, llm, now, tools = consultationTools } = deps;

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

    const history = await loadHistory(db, turn, at);
    const isNewConversation = !(await sentRecently(db, turn, at));

    // Lo que la clienta tocó en botones o listas se resuelve y se vuelve a validar acá: el modelo
    // recibe la elección ya resuelta y nunca interpreta el título del botón (5.3).
    const choices: ResolvedChoice[] = [];
    const pendingMessages: LlmMessage[] = [];
    for (const message of turn.messages) {
      const described = describeInbound(message.type, message.content);
      pendingMessages.push({ role: 'user', text: described.text });
      if (described.replyId) {
        choices.push(await resolveChoice(db, { tenantId, now: at, timeZone: tenant.timeZone }, described.replyId));
      }
    }

    const { message, run } = await runAgent(
      { llm, tools, logger, ...(deps.monotonicNow ? { monotonicNow: deps.monotonicNow } : {}) },
      {
        system: buildSystemPrompt(tenant),
        turnContext: buildTurnContext({
          now: at,
          timeZone: tenant.timeZone,
          isNewConversation,
          customerName: customer.name ?? customer.profileName,
          preferredProfessionalName,
          choices,
        }),
        history: [...history, ...pendingMessages],
        toolContext: { db, tenantId, customerId, now: at, timeZone: tenant.timeZone, signal },
      },
    );

    await saveRun(db, { tenantId, conversationId, run, createdAt: at });
    // Solo métricas: ni el contenido de los mensajes ni el de las herramientas (10.1).
    logger.info(
      {
        outcome: run.outcome,
        model: run.model,
        llmCalls: run.llmCalls,
        toolCalls: run.toolCalls,
        latencyMs: run.latencyMs,
        ...run.usage,
        isNewConversation,
      },
      'Respuesta del agente',
    );
    return message;
  };
}

/**
 * Los mensajes anteriores a los pendientes: hasta 20 de las últimas 24 horas, entrantes ya
 * procesados y salientes. Los entrantes sin procesar son los pendientes (o llegaron después y
 * son de la próxima vuelta): nunca van en el historial, así no se repite ninguno.
 */
async function loadHistory(db: NodePgDatabase, turn: ConversationTurn, at: Date): Promise<LlmMessage[]> {
  const rows = await db
    .select({ direction: messages.direction, type: messages.type, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, turn.tenantId),
        eq(messages.conversationId, turn.conversationId),
        gt(messages.occurredAt, new Date(at.getTime() - HISTORY_WINDOW_MS)),
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
      // Una elección vieja se muestra con el título que tocó: ya se atendió en su momento.
      const text = described.replyId ? `${described.text} «${described.replyTitle ?? ''}»` : described.text;
      history.push({ role: 'user', text });
    } else {
      const text = outgoingToText(row.content);
      if (text) history.push({ role: 'assistant', text });
    }
  }
  // La API exige que la conversación empiece con la clienta.
  while (history[0]?.role === 'assistant') history.shift();
  return history;
}

/** ¿El asistente le escribió a la clienta en las últimas 24 horas? (5.1) */
async function sentRecently(db: NodePgDatabase, turn: ConversationTurn, at: Date): Promise<boolean> {
  const [recent] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, turn.tenantId),
        eq(messages.conversationId, turn.conversationId),
        eq(messages.direction, 'outbound'),
        gt(messages.occurredAt, new Date(at.getTime() - NEW_CONVERSATION_AFTER_MS)),
      ),
    )
    .limit(1);
  return recent !== undefined;
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
