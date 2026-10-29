import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createAgentResponder } from '../../src/modules/conversation/agent/agent-responder.js';
import type { LlmClient } from '../../src/modules/conversation/agent/llm-client.js';
import { agentRuns } from '../../src/modules/conversation/schema.js';
import { resolveChoice } from '../../src/modules/conversation/tools/choices.js';
import type { FreeFormMessage } from '../../src/modules/whatsapp/outgoing.js';
import { createLogger } from '../../src/shared/logger.js';
import { EVAL_NOW, EVAL_TIME_ZONE } from './clock.js';
import type { EvalCase, EvalOption, EvalResult } from './evaluate.js';
import { parseLocalStart } from './local-time.js';
import { prepareCase } from './prepare.js';
import { deleteAppointmentsOf, readEvalState } from './state.js';

export { EvalPreparationError } from './prepare.js';

/**
 * Correr un caso de evaluación (sección 11.4): arma una clienta nueva con su conversación en el
 * negocio y el estado previo del caso (`prepare.ts`), guarda sus mensajes como entrantes
 * pendientes, corre el agente de verdad (`createAgentResponder`) con el `LlmClient` que se le pase
 * y junta lo que dejó la vuelta: la respuesta y el estado que quedó en la base.
 *
 * Recibe el `LlmClient` para poder usarlo con el modelo real (`run.eval.ts`) o con uno falso
 * guionado (tests de integración). No envía nada por WhatsApp: se queda con el mensaje que
 * el worker habría enviado. Al terminar (bien o mal) borra los turnos que armó el caso y los que
 * creó el agente: los casos comparten los horarios de Mica y Sofi.
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
  /** Por defecto, la hora fija de las evaluaciones (un caso puede moverla con `ahora`). */
  now?: Date;
  signal?: AbortSignal;
}

function optionsOf(message: FreeFormMessage): Omit<EvalOption, 'resuelta'>[] {
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

export async function runEvalCase(deps: RunCaseDependencies, evalCase: EvalCase): Promise<EvalResult> {
  const { db, tenantId, llm } = deps;
  const now = evalCase.ahora ? parseLocalStart(evalCase.ahora, EVAL_TIME_ZONE) : (deps.now ?? EVAL_NOW);
  const signal = deps.signal ?? AbortSignal.timeout(EVAL_CASE_TIMEOUT_MS);

  const prepared = await prepareCase({ db, tenantId }, evalCase, now);
  const { customerId, conversationId, received } = prepared;

  try {
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

    // Cada opción se vuelve a resolver a la hora de la vuelta, como cuando la clienta la toca.
    const options: EvalOption[] = [];
    for (const option of message ? optionsOf(message) : []) {
      options.push({
        ...option,
        resuelta: await resolveChoice(db, { tenantId, customerId, now, timeZone: EVAL_TIME_ZONE }, option.id),
      });
    }

    const estado = await readEvalState(db, {
      tenantId,
      customerId,
      conversationId,
      otherCustomerIds: prepared.otherCustomerIds,
      appointmentKeys: prepared.appointmentKeys,
      timeZone: EVAL_TIME_ZONE,
    });

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
      estado,
    };
  } finally {
    await deleteAppointmentsOf(db, { tenantId, customerIds: [customerId, ...prepared.otherCustomerIds] });
  }
}
