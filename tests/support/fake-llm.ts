import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmToolCall,
  LlmUsage,
} from '../../src/modules/conversation/agent/llm-client.js';

/**
 * Un modelo de mentira para los tests: contesta con un guion, sin red y sin costo. Cada paso
 * es la respuesta que da en esa llamada, o una función que la arma a partir del pedido.
 */
export type ScriptStep = LlmResponse | ((request: LlmRequest) => LlmResponse | Promise<LlmResponse>);

export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

let turnCounter = 0;

function base(overrides: Partial<LlmResponse>): LlmResponse {
  turnCounter += 1;
  return {
    assistantTurn: { raw: `turno-${String(turnCounter)}` },
    toolCalls: [],
    text: '',
    stopReason: 'end',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 'modelo-de-prueba',
    ...overrides,
  };
}

/** La respuesta final del modelo, con la forma de `{ texto, opciones }`. */
export function finalAnswer(texto: string, opciones: string[] = [], overrides: Partial<LlmResponse> = {}): LlmResponse {
  return base({ text: JSON.stringify({ texto, opciones }), ...overrides });
}

/** El modelo pide herramientas. */
export function callTools(
  calls: { name: string; input?: unknown; id?: string }[],
  overrides: Partial<LlmResponse> = {},
): LlmResponse {
  const toolCalls: LlmToolCall[] = calls.map((call, index) => ({
    id: call.id ?? `toolu_${String(turnCounter + 1)}_${String(index)}`,
    name: call.name,
    input: call.input ?? {},
  }));
  return base({ toolCalls, stopReason: 'tool_calls', ...overrides });
}

/** Una respuesta con el texto crudo, para probar salidas inválidas. */
export function rawAnswer(text: string, overrides: Partial<LlmResponse> = {}): LlmResponse {
  return base({ text, ...overrides });
}

export function scriptedLlm(script: ScriptStep[]) {
  /** Una copia de cada pedido tal como llegó (el ciclo sigue agregando mensajes a su lista). */
  const requests: LlmRequest[] = [];
  const llm: LlmClient = {
    async complete(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const step = script[requests.length - 1];
      if (!step) throw new Error(`El guion no tiene la llamada ${String(requests.length)}`);
      return typeof step === 'function' ? await step(request) : step;
    },
  };
  return { llm, requests };
}
