import { randomInt, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createAgentResponder } from '../../src/modules/conversation/agent/agent-responder.js';
import type { LlmClient } from '../../src/modules/conversation/agent/llm-client.js';
import type { ReceivedMessage } from '../../src/modules/conversation/processing.js';
import { agentRuns, conversations, messages } from '../../src/modules/conversation/schema.js';
import { resolveChoice } from '../../src/modules/conversation/tools/choices.js';
import { customers } from '../../src/modules/customers/schema.js';
import type { OutgoingMessage } from '../../src/modules/whatsapp/outgoing.js';
import { createLogger } from '../../src/shared/logger.js';
import { EVAL_NOW, EVAL_TIME_ZONE } from './clock.js';
import type { EvalCase, EvalOption, EvalResult } from './evaluate.js';

/**
 * Correr un caso de evaluación (sección 11.4): arma una clienta nueva con su conversación en el
 * negocio, guarda sus mensajes como entrantes pendientes, corre el agente de verdad
 * (`createAgentResponder`) con el `LlmClient` que se le pase y junta lo que dejó la vuelta.
 *
 * Recibe el `LlmClient` para poder usarlo con el modelo real (`run.eval.ts`) o con uno falso
 * guionado (tests de integración). No envía nada por WhatsApp: se queda con el mensaje que
 * el worker habría enviado.
 */

/**
 * Tiempo máximo de un caso. El test de Vitest tiene 60 s: la señal vence un poco antes para que
 * el error sea "se canceló por tiempo" y no el genérico del test.
 */
export const EVAL_CASE_TIMEOUT_MS = 55_000;

export interface RunCaseDependencies {
  db: NodePgDatabase;
  llm: LlmClient;
  /** El negocio con los datos de "Estética Ejemplo" ya cargados. */
  tenantId: string;
  /** Por defecto, la hora fija de las evaluaciones. */
  now?: Date;
  signal?: AbortSignal;
}

function optionsOf(message: OutgoingMessage): Omit<EvalOption, 'resuelta'>[] {
  switch (message.type) {
    case 'text':
      return [];
    case 'buttons':
      return message.buttons.map((button) => ({ id: button.id, titulo: button.title, descripcion: null }));
    case 'list':
      return message.sections.flatMap((section) =>
        section.rows.map((row) => ({ id: row.id, titulo: row.title, descripcion: row.description ?? null })),
      );
  }
}

/** Una clienta nueva con su conversación y los mensajes pendientes del caso. */
async function createTurn(deps: RunCaseDependencies, evalCase: EvalCase, now: Date) {
  const { db, tenantId } = deps;

  const [customer] = await db
    .insert(customers)
    .values({ tenantId, phone: `+549261${String(randomInt(0, 100_000_000)).padStart(8, '0')}` })
    .returning({ id: customers.id });
  if (!customer) throw new Error('No se creó la clienta de la evaluación');

  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId, customerId: customer.id })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error('No se creó la conversación de la evaluación');

  const received: ReceivedMessage[] = [];
  for (const [index, text] of evalCase.mensajes.entries()) {
    const content = { type: 'text', text: { body: text } };
    // Llegan de a un segundo, unos segundos antes de la hora fija.
    const occurredAt = new Date(now.getTime() - (evalCase.mensajes.length - index) * 1_000);
    const [row] = await db
      .insert(messages)
      .values({
        tenantId,
        conversationId: conversation.id,
        direction: 'inbound',
        type: 'text',
        content,
        whatsappMessageId: `wamid.eval.${randomUUID()}`,
        occurredAt,
        processedAt: null,
      })
      .returning({ id: messages.id });
    if (!row) throw new Error('No se guardó un mensaje de la evaluación');
    received.push({ id: row.id, type: 'text', content, occurredAt });
  }

  return { customerId: customer.id, conversationId: conversation.id, received };
}

export async function runEvalCase(deps: RunCaseDependencies, evalCase: EvalCase): Promise<EvalResult> {
  const { db, tenantId, llm } = deps;
  const now = deps.now ?? EVAL_NOW;
  const signal = deps.signal ?? AbortSignal.timeout(EVAL_CASE_TIMEOUT_MS);

  const { customerId, conversationId, received } = await createTurn(deps, evalCase, now);

  const respond = createAgentResponder({
    db,
    llm,
    logger: createLogger({ logLevel: 'silent' }),
    now: () => now,
  });
  const message = await respond({ tenantId, conversationId, customerId, messages: received }, { signal });

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.conversationId, conversationId)));
  if (!run) throw new Error('El agente no registró la vuelta en agent_runs');

  // Cada opción se vuelve a resolver a la hora fija, como cuando la clienta la toca.
  const options: EvalOption[] = [];
  for (const option of message ? optionsOf(message) : []) {
    options.push({
      ...option,
      resuelta: await resolveChoice(db, { tenantId, now, timeZone: EVAL_TIME_ZONE }, option.id),
    });
  }

  return {
    texto: message && 'body' in message ? message.body : '',
    tipo: message?.type ?? 'text',
    opciones: options,
    herramientas: run.toolCalls,
    outcome: run.outcome,
    tokens: {
      entrada: run.inputTokens,
      salida: run.outputTokens,
      cacheLectura: run.cacheReadTokens,
      cacheEscritura: run.cacheWriteTokens,
    },
    latenciaMs: run.latencyMs,
  };
}
