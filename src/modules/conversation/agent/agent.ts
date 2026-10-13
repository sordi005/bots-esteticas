import type { Logger } from 'pino';
import { z } from 'zod';
import { outgoingMessageSchema, type OutgoingMessage } from '../../whatsapp/outgoing.js';
import { truncateText } from '../format.js';
import {
  MAX_LIST_ROWS,
  MAX_OPTION_DESCRIPTION_LENGTH,
  MAX_OPTION_TITLE_LENGTH,
  runTool,
  type AgentTool,
  type OfferableOption,
  type ToolContext,
} from '../tools/tool.js';
import type { LlmClient, LlmMessage, LlmResponse, LlmToolCall, LlmToolResult, LlmUsage } from './llm-client.js';
import type { AgentOutcome } from './outcome.js';

/**
 * El ciclo del agente (8.5, decisión 20): llama al modelo, ejecuta las herramientas que pide,
 * le devuelve los resultados y vuelve a llamar hasta que contesta. Es código propio y no
 * conoce al proveedor: recibe un `LlmClient`, así se prueba con uno falso y se aplican los
 * topes, la cancelación y el registro.
 */

/** [S] Tope de llamadas a herramientas por respuesta, para cortar bucles del modelo (9.1). */
export const MAX_TOOL_CALLS_PER_REPLY = 8;

/** Lo que se le envía a la clienta cuando el modelo no dio una respuesta que se pueda usar. */
export const FALLBACK_REPLY_TEXT = 'Perdón, no te entendí bien. ¿Me lo escribís de otra forma?';

/**
 * Lo que se le envía a la clienta cuando el modelo falla dos veces seguidas y el código deriva a una
 * persona (4.8, 8.5). `{cuándo}` se completa con el texto del horario de atención humana.
 */
export const NOT_UNDERSTOOD_HANDOFF_TEXT =
  'Perdón, no te estoy entendiendo. Le paso tu consulta a una persona del equipo, que te va a responder por acá {cuándo}.';

export function notUnderstoodHandoffText(when: string): string {
  return NOT_UNDERSTOOD_HANDOFF_TEXT.replace('{cuándo}', when);
}

/**
 * Lo que se le dice al modelo cuando su respuesta promete una persona (`derivada=true`) y en la vuelta
 * no se derivó nada (6.4). Se le hace notar una sola vez, con el turno que acaba de dar.
 */
export const UNFULFILLED_HANDOFF_NOTICE =
  'En tu respuesta pusiste derivada=true pero no llamaste a derivar_a_persona y no se derivó la conversación. Si corresponde derivar, llamala ahora con el motivo y un resumen; si no, corregí el texto para no prometer que la atiende una persona.';

/** Máximos de WhatsApp (outgoing.ts). */
const MAX_TEXT_LENGTH = 4_096;
const MAX_BUTTONS = 3;
const MAX_BUTTON_BODY_LENGTH = 1_024;
const MAX_ROW_TITLE_LENGTH = 24;
const LIST_BUTTON_LABEL = 'Ver opciones';

/**
 * La respuesta final del modelo. Los nombres van en español porque los ve el modelo (6.4).
 * El esquema JSON es a mano: los proveedores no aceptan mínimos ni máximos, así que el largo
 * del texto se valida acá, del lado nuestro.
 */
const finalAnswerSchema = z.object({
  texto: z.string().trim().min(1),
  opciones: z.array(z.string()),
  derivada: z.boolean(),
});

type FinalAnswer = z.infer<typeof finalAnswerSchema>;

export const FINAL_ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    texto: {
      type: 'string',
      description: 'El mensaje para la clienta, listo para enviar.',
    },
    opciones: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Ids de las opciones que la clienta puede elegir con un botón o una fila de lista. Solo ids que devolvieron las herramientas en esta respuesta. Lista vacía si no hay nada para elegir.',
    },
    derivada: {
      type: 'boolean',
      description:
        'true si en el texto le decís a la clienta que una persona del equipo la va a atender, le va a responder o va a ver, revisar o recibir su consulta o su reclamo; false si no.',
    },
  },
  required: ['texto', 'opciones', 'derivada'],
  additionalProperties: false,
};

/** El registro de una vuelta (tabla `agent_runs`). Nunca incluye contenido. */
export interface AgentRun {
  /** Modelo de la última llamada. */
  model: string;
  llmCalls: number;
  usage: LlmUsage;
  /** Solo los nombres, en el orden en que se ejecutaron (sin argumentos ni resultados). */
  toolCalls: string[];
  latencyMs: number;
  outcome: AgentOutcome;
}

export interface AgentDependencies {
  llm: LlmClient;
  tools: AgentTool<unknown>[];
  logger: Logger;
  /** Reloj monotónico en milisegundos, para medir la latencia. Se inyecta en los tests. */
  monotonicNow?: () => number;
}

export interface AgentInput {
  /** Prompt del sistema del negocio: estable. */
  system: string;
  /** Lo que cambia en cada vuelta: fecha y hora, conversación nueva, nombre de la clienta. */
  turnContext: string;
  /** El historial más los mensajes pendientes, del más viejo al más nuevo; termina en la clienta. */
  history: LlmMessage[];
  /** Del servidor: el negocio y la clienta nunca los elige el modelo (regla 2). */
  toolContext: ToolContext;
}

export interface AgentResult {
  message: OutgoingMessage;
  run: AgentRun;
}

export type FallbackOutcome = Extract<AgentOutcome, `fallback_${string}`>;

/** ¿La vuelta terminó con la frase fija porque el modelo no dio una respuesta usable? */
export function isFallbackOutcome(outcome: AgentOutcome): outcome is FallbackOutcome {
  return outcome.startsWith('fallback_');
}

function addUsage(total: LlmUsage, usage: LlmUsage): LlmUsage {
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
  };
}

/** Lo que devuelve una herramienta ejecutada: el resultado para el modelo y si derivó la conversación. */
interface ToolExecution {
  result: LlmToolResult;
  handedOff: boolean;
}

/** Ejecuta una herramienta pedida por el modelo y arma el resultado que se le devuelve. */
async function executeToolCall(
  call: LlmToolCall,
  tools: Map<string, AgentTool<unknown>>,
  ctx: ToolContext,
  offered: Map<string, OfferableOption>,
): Promise<ToolExecution> {
  const tool = tools.get(call.name);
  if (!tool) {
    return {
      result: {
        toolCallId: call.id,
        content: JSON.stringify({ error: `No existe la herramienta ${call.name}` }),
        isError: true,
      },
      handedOff: false,
    };
  }
  const result = await runTool(tool, call.input, ctx);
  for (const option of result.options) offered.set(option.id, option);
  return {
    result: { toolCallId: call.id, content: JSON.stringify(result.content), isError: result.isError ?? false },
    handedOff: result.handedOff ?? false,
  };
}

/** Arma el mensaje de WhatsApp: texto solo, botones o lista, según lo que haya para elegir. */
function buildOutgoingMessage(texto: string, options: OfferableOption[]): OutgoingMessage {
  const body = texto.slice(0, MAX_TEXT_LENGTH);
  const textOnly: OutgoingMessage = { type: 'text', body };
  if (options.length === 0) return textOnly;

  const fitsButtons =
    options.length <= MAX_BUTTONS &&
    texto.length <= MAX_BUTTON_BODY_LENGTH &&
    options.every((option) => option.title.length <= MAX_OPTION_TITLE_LENGTH);

  const candidate: OutgoingMessage = fitsButtons
    ? { type: 'buttons', body: texto, buttons: options.map(({ id, title }) => ({ id, title })) }
    : {
        type: 'list',
        body,
        buttonLabel: LIST_BUTTON_LABEL,
        sections: [
          {
            rows: options.slice(0, MAX_LIST_ROWS).map(({ id, title, description }) => ({
              id,
              title: truncateText(title, MAX_ROW_TITLE_LENGTH),
              ...(description ? { description: truncateText(description, MAX_OPTION_DESCRIPTION_LENGTH) } : {}),
            })),
          },
        ],
      };

  // Un mensaje que WhatsApp rechazaría (ids muy largos, por ejemplo) nunca llega a la API: se contesta solo con el texto.
  return outgoingMessageSchema.safeParse(candidate).success ? candidate : textOnly;
}

/** Interpreta la salida final del modelo: null si no tiene la forma pedida. */
function parseFinalAnswer(text: string): FinalAnswer | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = finalAnswerSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export async function runAgent(deps: AgentDependencies, input: AgentInput): Promise<AgentResult> {
  const { llm, logger, monotonicNow = () => performance.now() } = deps;
  const { toolContext } = input;
  const { signal } = toolContext;
  const startedAt = monotonicNow();

  const toolsByName = new Map(deps.tools.map((tool) => [tool.name, tool]));
  const toolDefinitions = deps.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: 'input' }),
  }));

  // Las opciones que ofrecieron las herramientas en ESTA vuelta: lo único que el modelo puede ofrecer.
  const offered = new Map<string, OfferableOption>();
  const executedTools: string[] = [];
  const messages = [...input.history];
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let llmCalls = 0;
  let hitToolLimit = false;
  // ¿Alguna herramienta derivó la conversación en esta vuelta? Lo dice el código, no el modelo (6.4).
  let handedOff = false;
  // Solo se le hace notar UNA vez que prometió una persona sin derivar.
  let corrected = false;
  let answer: FinalAnswer | null;
  let response: LlmResponse;

  for (;;) {
    signal.throwIfAborted();
    const allowTools = executedTools.length < MAX_TOOL_CALLS_PER_REPLY;
    response = await llm.complete({
      system: input.system,
      turnContext: input.turnContext,
      messages,
      tools: toolDefinitions,
      responseSchema: FINAL_ANSWER_JSON_SCHEMA,
      allowTools,
      signal,
    });
    llmCalls += 1;
    usage = addUsage(usage, response.usage);
    hitToolLimit ||= !allowTools;

    // Una respuesta cortada o rechazada puede traer herramientas a medias: no se ejecutan.
    if (!allowTools || response.stopReason !== 'tool_calls' || response.toolCalls.length === 0) {
      answer =
        response.stopReason === 'refusal' || response.stopReason === 'max_tokens' ? null : parseFinalAnswer(response.text);
      // Promete una persona y nadie fue avisado (6.4): una vez se lo hace notar para que derive o corrija el texto.
      // Un turno que quedó con herramientas pedidas no admite un mensaje de texto a continuación: la API exige sus resultados.
      if (answer?.derivada && !handedOff && !corrected && response.toolCalls.length === 0) {
        corrected = true;
        messages.push(
          { role: 'assistant_turn', turn: response.assistantTurn },
          { role: 'system_note', text: UNFULFILLED_HANDOFF_NOTICE },
        );
        continue;
      }
      break;
    }

    const room = MAX_TOOL_CALLS_PER_REPLY - executedTools.length;
    const executions = await Promise.all(
      response.toolCalls.map((call, index): Promise<ToolExecution> => {
        if (index >= room) {
          return Promise.resolve({
            result: {
              toolCallId: call.id,
              content: JSON.stringify({ error: 'Se llegó al tope de consultas de esta respuesta' }),
              isError: true,
            },
            handedOff: false,
          });
        }
        return executeToolCall(call, toolsByName, toolContext, offered);
      }),
    );
    const results = executions.map((execution) => execution.result);
    handedOff ||= executions.some((execution) => execution.handedOff);
    executedTools.push(...response.toolCalls.slice(0, room).map((call) => call.name));

    messages.push({ role: 'assistant_turn', turn: response.assistantTurn }, { role: 'tool_results', results });
  }

  const finish = (message: OutgoingMessage, outcome: AgentOutcome): AgentResult => ({
    message,
    run: {
      model: response.model,
      llmCalls,
      usage,
      toolCalls: executedTools,
      latencyMs: Math.round(monotonicNow() - startedAt),
      outcome,
    },
  });
  const fallback = (outcome: FallbackOutcome) => finish({ type: 'text', body: FALLBACK_REPLY_TEXT }, outcome);

  if (response.stopReason === 'refusal') return fallback('fallback_refusal');
  if (response.stopReason === 'max_tokens') return fallback('fallback_max_tokens');

  if (!answer) return fallback('fallback_invalid_output');
  // Sigue prometiendo una persona que nadie sabe que tiene que atenderla, ni después del aviso.
  if (answer.derivada && !handedOff) return fallback('fallback_unfulfilled_handoff');
  // El caso inverso no deja a nadie esperando en falso: no se corrige.
  if (!answer.derivada && handedOff) logger.debug('La respuesta no dice que derivó, pero la conversación se derivó');

  const requested = new Set(answer.opciones);
  const chosen: OfferableOption[] = [];
  for (const id of requested) {
    const option = offered.get(id);
    if (option) chosen.push(option);
  }
  const discarded = requested.size - chosen.length;
  if (discarded > 0) {
    // Solo la cantidad: ni los ids ni el texto de la conversación van al log.
    logger.debug({ discarded }, 'Se descartaron opciones que ninguna herramienta ofreció');
  }

  return finish(buildOutgoingMessage(answer.texto, chosen), hitToolLimit ? 'tool_limit' : 'replied');
}
