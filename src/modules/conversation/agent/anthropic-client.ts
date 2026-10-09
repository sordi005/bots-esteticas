import Anthropic from '@anthropic-ai/sdk';
import type {
  AssistantTurn,
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
} from './llm-client.js';

/**
 * El adaptador de `LlmClient` para la API de Claude (8.5). Es el ÚNICO archivo que importa el SDK
 * de Anthropic: el lint lo hace cumplir. Los errores tipados del SDK suben tal cual (la tarea
 * se reintenta, 6.7) y nunca se convierten en texto para la clienta.
 */

/** [S] Cada llamada tiene 20 segundos y un reintento, para entrar en los 60 s de la tarea (6.7, 8.5). */
export const ANTHROPIC_TIMEOUT_MS = 20_000;
export const ANTHROPIC_MAX_RETRIES = 1;
/** [S] Hasta 4.096 tokens de respuesta (8.5). El razonamiento también cuenta. */
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 4_096;
/** [S] Es una charla y la latencia importa: esfuerzo de razonamiento bajo (8.5). */
export const ANTHROPIC_EFFORT = 'low';

export interface AnthropicLlmClientOptions {
  apiKey: string;
  /** Por ejemplo `claude-haiku-5-5`: viene de `ANTHROPIC_MODEL`. */
  model: string;
  /** Para los tests: nunca se llama a la API real. */
  fetch?: typeof fetch;
}

type JsonSchema = Record<string, unknown>;

/** Restricciones que las herramientas estrictas y el formato de salida no aceptan (400). */
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
]);

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Pasa un JSON Schema (el que genera Zod) a lo que aceptan las herramientas con `strict: true`:
 * sin `$schema`, sin mínimos ni máximos, sin el `pattern` de los formatos que ya entiende la API
 * (el regex de Zod para uuid o date-time es demasiado complejo) y con `additionalProperties:
 * false` en todos los objetos. Lo que se quita no se pierde: cada herramienta vuelve a validar
 * la entrada con Zod (`runTool`). No modifica el esquema original.
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!isRecord(node)) return node;

    const result: JsonSchema = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_KEYWORDS.has(key)) continue;
      if (key === 'minItems' && typeof value === 'number' && value > 1) continue;
      if (key === 'pattern' && typeof node.format === 'string') continue;
      // Los nombres de las propiedades no son palabras clave: solo se recorren sus valores.
      if (key === 'properties' && isRecord(value)) {
        result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child)]));
      } else {
        result[key] = visit(value);
      }
    }
    if (result.type === 'object') result.additionalProperties = false;
    return result;
  };
  return visit(schema) as JsonSchema;
}

function toApiMessages(messages: LlmMessage[], turnContext: string): Anthropic.MessageParam[] {
  const converted = messages.map((message): Anthropic.MessageParam => {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: message.text };
      case 'assistant':
        return { role: 'assistant', content: message.text };
      case 'assistant_turn': {
        // El turno vuelve al modelo TAL CUAL: puede traer bloques de razonamiento firmados.
        const { raw } = message.turn;
        if (!Array.isArray(raw)) throw new TypeError('El turno del asistente no es de este adaptador');
        return { role: 'assistant', content: raw as Anthropic.ContentBlockParam[] };
      }
      case 'tool_results':
        return {
          role: 'user',
          content: message.results.map(
            (result): Anthropic.ToolResultBlockParam => ({
              type: 'tool_result',
              tool_use_id: result.toolCallId,
              content: result.content,
              is_error: result.isError,
            }),
          ),
        };
    }
  });
  if (turnContext === '') return converted;

  // El contexto de la vuelta va como mensaje de sistema a mitad de la conversación, justo después
  // del último mensaje de la clienta (Haiku 5.5 lo soporta sin beta). Así el prompt del sistema
  // queda idéntico y la caché se reutiliza. Siempre queda antes del turno del asistente, nunca
  // entre una herramienta y su resultado.
  const lastUser = messages.findLastIndex((message) => message.role === 'user');
  const at = lastUser === -1 ? 0 : lastUser + 1;
  return [...converted.slice(0, at), { role: 'system', content: turnContext }, ...converted.slice(at)];
}

function toStopReason(reason: Anthropic.StopReason | null): LlmStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function toLlmResponse(message: Anthropic.Message): LlmResponse {
  const assistantTurn: AssistantTurn = { raw: message.content };
  return {
    assistantTurn,
    toolCalls: message.content.flatMap((block) =>
      block.type === 'tool_use' ? [{ id: block.id, name: block.name, input: block.input }] : [],
    ),
    text: message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
    stopReason: toStopReason(message.stop_reason),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
    model: message.model,
  };
}

export function createAnthropicLlmClient(options: AnthropicLlmClientOptions): LlmClient {
  const anthropic = new Anthropic({
    apiKey: options.apiKey,
    timeout: ANTHROPIC_TIMEOUT_MS,
    maxRetries: ANTHROPIC_MAX_RETRIES,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const message = await anthropic.messages.create(
        {
          model: options.model,
          max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
          // Idéntico entre llamadas del mismo negocio: se cachea.
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          tools: request.tools.map(
            (tool): Anthropic.Tool => ({
              name: tool.name,
              description: tool.description,
              input_schema: toStrictSchema(tool.inputSchema) as Anthropic.Tool.InputSchema,
              strict: true,
            }),
          ),
          // Con `none` la lista de herramientas se manda igual, para no romper la caché.
          // Nunca `any` ni `tool`: Haiku 5.5 razona y elige solo.
          tool_choice: request.allowTools ? { type: 'auto' } : { type: 'none' },
          output_config: {
            effort: ANTHROPIC_EFFORT,
            format: { type: 'json_schema', schema: toStrictSchema(request.responseSchema) },
          },
          messages: toApiMessages(request.messages, request.turnContext),
        },
        { signal: request.signal },
      );
      return toLlmResponse(message);
    },
  };
}
