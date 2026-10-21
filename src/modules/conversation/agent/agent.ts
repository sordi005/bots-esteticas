import type { Logger } from 'pino';
import { z } from 'zod';
import { freeFormMessageSchema, type FreeFormMessage } from '../../whatsapp/outgoing.js';
import { truncateText } from '../format.js';
import type { HandoffReason } from '../handoff.js';
import {
  isFillerSummary,
  MODEL_HANDOFF_REASON_NAMES,
  MODEL_HANDOFF_REASONS,
  type ModelHandoffReason,
} from '../handoff-reasons.js';
import {
  MAX_LIST_ROWS,
  MAX_OPTION_DESCRIPTION_LENGTH,
  MAX_OPTION_TITLE_LENGTH,
  runTool,
  type AgentTool,
  type OfferableOption,
  type ToolContext,
} from '../tools/tool.js';
import { claimsAppointmentChange } from './claimed-change.js';
import type { LlmClient, LlmMessage, LlmResponse, LlmToolCall, LlmToolResult, LlmUsage } from './llm-client.js';
import type { AgentOutcome } from './outcome.js';
import { announcesPendingWork } from './pending-work.js';

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
 * Lo que se le dice al modelo cuando su respuesta anuncia una búsqueda («dejame consultar…») y en la vuelta
 * no llamó a ninguna herramienta (6.4). Se le hace notar una sola vez, con el turno que acaba de dar.
 */
export const PENDING_WORK_NOTICE =
  'En tu respuesta anunciaste que ibas a buscar o consultar algo, pero no llamaste a ninguna herramienta, y la respuesta se envía tal cual: la clienta no recibiría nada más. Llamá ahora a las herramientas que hagan falta y contestá con el resultado. Si no hace falta consultar nada, contestá sin anunciar una búsqueda.';

/**
 * Lo que se le dice al modelo cuando su respuesta afirma que un turno quedó reservado, cancelado o reprogramado y
 * en la vuelta ninguna herramienta lo hizo (6.4). Se le hace notar una sola vez, con el turno que acaba de dar.
 */
export const UNCONFIRMED_CHANGE_NOTICE =
  'En tu respuesta dijiste que el turno quedó reservado, cancelado, reprogramado o confirmado (o que la seña llegó), pero ninguna herramienta lo hizo en esta respuesta: no cambió nada. Si la clienta lo eligió o lo confirmó, llamá ahora a la herramienta que corresponde (crear_reserva, cancelar_turno o reprogramar_turno) y contestá con lo que devuelva. La seña por transferencia la confirma una persona del equipo, nunca vos. Si no, corregí el texto: no le digas que pasó algo que no pasó; si el turno ya estaba confirmado desde antes, decilo como algo que ya estaba («está confirmado»).';

/**
 * Lo que se le dice al modelo cuando una herramienta devolvió los datos para pagar la seña y su respuesta no
 * los trae (4.5): sin el alias, la clienta no puede pagar. Se le hace notar una sola vez.
 */
export const PAYMENT_DETAILS_NOTICE =
  'Una herramienta devolvió los datos para pagar la seña («pago»), pero tu respuesta no los trae: sin el alias o el CBU la clienta no puede pagar. Volvé a escribir la respuesta con los datos de «pago» tal cual (sirve «pago.texto») y pedile la foto del comprobante.';

/**
 * El horario que la clienta eligió en esta vuelta con un botón o una lista y que sigue libre (5.3, 6.4): elegirlo ya
 * es la confirmación, así que la respuesta tiene que llamar a la herramienta que lo reserva o lo mueve. Lo arma el
 * código antes de llamar al modelo.
 */
export interface ChosenSlot {
  tool: 'crear_reserva' | 'reprogramar_turno';
  /** El id tal cual lo devolvió WhatsApp (`horario:` o `reprogramar:`). */
  slotId: string;
}

/**
 * Lo que se le dice al modelo cuando la clienta eligió un horario libre y su respuesta no llamó a la herramienta que
 * lo reserva o lo mueve (6.4). Se le hace notar una sola vez, con el turno que acaba de dar.
 */
export function chosenSlotNotice({ tool, slotId }: ChosenSlot): string {
  return `La clienta eligió un horario con un botón y sigue libre: elegirlo ya es la confirmación. Tu respuesta no lo reservó y la respuesta se envía tal cual. Llamá ahora a ${tool} con horario_id=${slotId} (tal cual) y contestá con lo que devuelva. Si devuelve que no se pudo, explicale por qué y ofrecé otros horarios.`;
}

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
 *
 * `derivar` es obligatorio: `null`, o el motivo y el resumen (decisión 27). Derivar es parte de la
 * respuesta y no una herramienta: la promesa («le paso tu consulta a una persona») y la acción salen
 * juntas. Un resumen de relleno invalida la respuesta entera (4.8); con un tema sensible no se
 * exige, porque el código guarda un resumen fijo y descarta el del modelo (regla 9).
 */
const handoffRequestSchema = z
  .object({
    motivo: z.enum(MODEL_HANDOFF_REASON_NAMES),
    resumen: z.string(),
  })
  .refine(({ motivo, resumen }) => motivo === 'tema_sensible' || !isFillerSummary(resumen));

const finalAnswerSchema = z.object({
  texto: z.string().trim().min(1),
  opciones: z.array(z.string()),
  derivar: handoffRequestSchema.nullable(),
});

type FinalAnswer = z.infer<typeof finalAnswerSchema>;

/** Cada motivo con lo que significa, para la descripción que lee el modelo. */
const REASON_DESCRIPTIONS = MODEL_HANDOFF_REASON_NAMES.map(
  (name: ModelHandoffReason) => `${name} (${MODEL_HANDOFF_REASONS[name].description})`,
).join(', ');

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
    derivar: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            motivo: {
              type: 'string',
              enum: [...MODEL_HANDOFF_REASON_NAMES],
              description: `Por qué se deriva: ${REASON_DESCRIPTIONS}.`,
            },
            resumen: {
              type: 'string',
              description:
                'Una sola línea para la dueña, de por lo menos 3 palabras y hasta 200 caracteres, con qué necesita la clienta de verdad (nada de relleno ni de pruebas). Solo lo que pide: sin el estado de sus turnos ni de sus pagos, que puede haber cambiado y la persona lo ve en el sistema. Con tema_sensible NO incluyas ningún dato de salud: escribí solo "consulta sensible".',
            },
          },
          required: ['motivo', 'resumen'],
          additionalProperties: false,
        },
      ],
      description:
        'null si no derivás. Completalo (motivo y resumen) cuando tu texto le dice a la clienta que una persona del equipo la va a atender, le va a responder o va a ver, revisar o recibir su consulta o su reclamo: la derivación sale con esta respuesta y pausa al asistente en este chat.',
    },
  },
  required: ['texto', 'opciones', 'derivar'],
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
  /** El horario libre que la clienta eligió en esta vuelta, si hay uno para reservar o mover ya. */
  chosenSlot?: ChosenSlot;
}

/** La derivación que pidió la respuesta del modelo, con el motivo ya traducido al de la base (4.8). */
export interface AgentHandoff {
  reason: HandoffReason;
  /** Lo que escribió el modelo: con un tema sensible, quien registra la derivación lo descarta (regla 9). */
  summary: string;
}

export interface AgentResult {
  message: FreeFormMessage;
  /** Si la respuesta pidió derivar. El ciclo no conoce la base: quien lo llama registra la derivación. */
  handoff: AgentHandoff | null;
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

/** Lo que devuelve ejecutar una herramienta: el resultado para el modelo y si dejó un turno cambiado. */
interface ExecutedToolCall {
  result: LlmToolResult;
  changedAppointment: boolean;
  mustMention?: string;
}

/** Ejecuta una herramienta pedida por el modelo y arma el resultado que se le devuelve. */
async function executeToolCall(
  call: LlmToolCall,
  tools: Map<string, AgentTool<unknown>>,
  ctx: ToolContext,
  offered: Map<string, OfferableOption>,
): Promise<ExecutedToolCall> {
  const tool = tools.get(call.name);
  if (!tool) {
    return {
      result: {
        toolCallId: call.id,
        content: JSON.stringify({ error: `No existe la herramienta ${call.name}` }),
        isError: true,
      },
      changedAppointment: false,
    };
  }
  const result = await runTool(tool, call.input, ctx);
  for (const option of result.options) offered.set(option.id, option);
  return {
    result: { toolCallId: call.id, content: JSON.stringify(result.content), isError: result.isError ?? false },
    changedAppointment: result.changedAppointment === true,
    ...(result.mustMention ? { mustMention: result.mustMention } : {}),
  };
}

/** ¿El texto deja afuera algún dato que tenía que decir? Sin distinguir mayúsculas. */
function missesRequiredMention(text: string, required: ReadonlySet<string>): boolean {
  const folded = text.toLowerCase();
  return [...required].some((value) => !folded.includes(value.toLowerCase()));
}

/** Arma el mensaje de WhatsApp: texto solo, botones o lista, según lo que haya para elegir. */
function buildFreeFormMessage(texto: string, options: OfferableOption[]): FreeFormMessage {
  const body = texto.slice(0, MAX_TEXT_LENGTH);
  const textOnly: FreeFormMessage = { type: 'text', body };
  if (options.length === 0) return textOnly;

  const fitsButtons =
    options.length <= MAX_BUTTONS &&
    texto.length <= MAX_BUTTON_BODY_LENGTH &&
    options.every((option) => option.title.length <= MAX_OPTION_TITLE_LENGTH);

  const candidate: FreeFormMessage = fitsButtons
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
  return freeFormMessageSchema.safeParse(candidate).success ? candidate : textOnly;
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

/** El texto afirma que un turno cambió y en la vuelta ninguna herramienta lo confirmó (6.4). */
function unconfirmedChange(text: string, changedAppointment: boolean): boolean {
  return !changedAppointment && claimsAppointmentChange(text);
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
  // Alguna herramienta dejó un turno reservado, cancelado o reprogramado en esta vuelta.
  let changedAppointment = false;
  // Lo que la respuesta tiene que decir: los datos para pagar la seña (4.5).
  const requiredMentions = new Set<string>();
  // Solo se le hace notar UNA vez, por lo que sea: un anuncio de búsqueda sin hacerla o un cambio que no pasó.
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
      // Anuncia una búsqueda y en toda la vuelta no consultó nada (6.4): la respuesta se envía tal cual, así que
      // una vez se lo hace notar. Un turno que quedó con herramientas pedidas no admite un mensaje de texto a
      // continuación: la API exige sus resultados.
      const announcesWithoutTools =
        answer !== null &&
        executedTools.length === 0 &&
        response.toolCalls.length === 0 &&
        announcesPendingWork(answer.texto);
      if (announcesWithoutTools && !corrected) {
        corrected = true;
        messages.push(
          { role: 'assistant_turn', turn: response.assistantTurn },
          { role: 'system_note', text: PENDING_WORK_NOTICE },
        );
        continue;
      }
      // Afirma un cambio que ninguna herramienta hizo en la vuelta (6.4): nunca se le confirma a la clienta algo que no
      // pasó, así que una vez se lo hace notar. Con un cambio confirmado en la vuelta no hay nada que corregir.
      const claimsUnconfirmedChange = answer !== null && unconfirmedChange(answer.texto, changedAppointment);
      if (claimsUnconfirmedChange && response.toolCalls.length === 0 && !corrected) {
        corrected = true;
        messages.push(
          { role: 'assistant_turn', turn: response.assistantTurn },
          { role: 'system_note', text: UNCONFIRMED_CHANGE_NOTICE },
        );
        continue;
      }
      // Una herramienta devolvió los datos para pagar la seña y el texto no los trae (4.5): una vez se lo hace
      // notar. Si los vuelve a omitir, se envía igual: no afirma nada falso.
      const missesPayment = answer !== null && missesRequiredMention(answer.texto, requiredMentions);
      if (missesPayment && response.toolCalls.length === 0 && !corrected) {
        corrected = true;
        messages.push(
          { role: 'assistant_turn', turn: response.assistantTurn },
          { role: 'system_note', text: PAYMENT_DETAILS_NOTICE },
        );
        continue;
      }
      // Eligió un horario libre y en la vuelta no se llamó a la herramienta que lo reserva o lo mueve (6.4): una vez
      // se lo hace notar. Si deriva, no: la persona del equipo sigue desde ahí.
      const skipsChosenSlot =
        answer !== null &&
        input.chosenSlot !== undefined &&
        answer.derivar === null &&
        !executedTools.includes(input.chosenSlot.tool);
      if (skipsChosenSlot && input.chosenSlot && response.toolCalls.length === 0 && !corrected) {
        corrected = true;
        messages.push(
          { role: 'assistant_turn', turn: response.assistantTurn },
          { role: 'system_note', text: chosenSlotNotice(input.chosenSlot) },
        );
        continue;
      }
      if (skipsChosenSlot) logger.debug('La respuesta no reservó el horario que eligió la clienta');
      if (missesPayment) logger.debug('La respuesta no trae los datos para pagar la seña');
      // Volvió a anunciar: se envía igual. Sin el texto, que es de la conversación.
      if (announcesWithoutTools) logger.debug('La respuesta volvió a anunciar una búsqueda sin llamar a ninguna herramienta');
      break;
    }

    const room = MAX_TOOL_CALLS_PER_REPLY - executedTools.length;
    const executed = await Promise.all(
      response.toolCalls.map((call, index): Promise<ExecutedToolCall> => {
        if (index >= room) {
          return Promise.resolve({
            result: {
              toolCallId: call.id,
              content: JSON.stringify({ error: 'Se llegó al tope de consultas de esta respuesta' }),
              isError: true,
            },
            changedAppointment: false,
          });
        }
        return executeToolCall(call, toolsByName, toolContext, offered);
      }),
    );
    executedTools.push(...response.toolCalls.slice(0, room).map((call) => call.name));
    changedAppointment ||= executed.some((call) => call.changedAppointment);
    for (const call of executed) if (call.mustMention) requiredMentions.add(call.mustMention);

    messages.push(
      { role: 'assistant_turn', turn: response.assistantTurn },
      { role: 'tool_results', results: executed.map((call) => call.result) },
    );
  }

  const finish = (message: FreeFormMessage, outcome: AgentOutcome, handoff: AgentHandoff | null): AgentResult => ({
    message,
    handoff,
    run: {
      model: response.model,
      llmCalls,
      usage,
      toolCalls: executedTools,
      latencyMs: Math.round(monotonicNow() - startedAt),
      outcome,
    },
  });
  // Una respuesta que no se puede usar nunca deriva: la clienta recibe la frase fija y nada se pausa.
  const fallback = (outcome: FallbackOutcome) => finish({ type: 'text', body: FALLBACK_REPLY_TEXT }, outcome, null);

  if (response.stopReason === 'refusal') return fallback('fallback_refusal');
  if (response.stopReason === 'max_tokens') return fallback('fallback_max_tokens');

  if (!answer) return fallback('fallback_invalid_output');

  // Sigue afirmando un cambio que no pasó, o no hubo forma de avisarle (quedaron herramientas pedidas sin ejecutar):
  // la clienta nunca recibe una confirmación falsa. Sin el texto en el log, que es de la conversación.
  if (unconfirmedChange(answer.texto, changedAppointment)) {
    logger.debug('La respuesta afirma un cambio de turno que ninguna herramienta confirmó');
    return fallback('fallback_unconfirmed_change');
  }

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

  const handoff: AgentHandoff | null = answer.derivar
    ? { reason: MODEL_HANDOFF_REASONS[answer.derivar.motivo].reason, summary: answer.derivar.resumen }
    : null;
  return finish(buildFreeFormMessage(answer.texto, chosen), hitToolLimit ? 'tool_limit' : 'replied', handoff);
}
