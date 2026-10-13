/**
 * Interfaz neutral del modelo de IA (sección 8.5, decisión 20). Nada de este archivo ni del
 * ciclo del agente conoce al proveedor: el único archivo que importa un SDK es el adaptador
 * (`anthropic-client.ts`), y el lint lo hace cumplir. Los tests usan un cliente falso.
 */

/** Una herramienta tal como la ve el modelo. */
export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema de la entrada. */
  inputSchema: Record<string, unknown>;
}

/** El modelo pidió usar una herramienta. `input` viene sin validar: lo valida la herramienta. */
export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmToolResult {
  toolCallId: string;
  /** Lo que lee el modelo, ya serializado. */
  content: string;
  /** La herramienta rechazó el pedido o falló: el modelo lo corrige o lo explica. */
  isError: boolean;
}

/**
 * Un turno del asistente tal como lo devolvió el modelo. Es opaco para el resto del código: el
 * ciclo lo guarda y se lo reenvía al adaptador TAL CUAL en la siguiente llamada de la misma
 * vuelta. El modelo puede incluir bloques de razonamiento que la API exige recibir sin
 * cambios; por eso nunca se reconstruye a partir del texto o de las llamadas.
 */
export interface AssistantTurn {
  /** Solo lo interpreta el adaptador que lo creó. */
  readonly raw: unknown;
}

export type LlmMessage =
  /** Lo que escribió la clienta (o un marcador de un mensaje que no es texto). */
  | { role: 'user'; text: string }
  /** Una respuesta anterior del asistente, leída del historial (solo texto). */
  | { role: 'assistant'; text: string }
  /** El turno del asistente de ESTA vuelta, que pidió herramientas. */
  | { role: 'assistant_turn'; turn: AssistantTurn }
  /** Todos los resultados de las herramientas de un mismo turno, juntos. */
  | { role: 'tool_results'; results: LlmToolResult[] };

export interface LlmRequest {
  /** Estable e idéntico entre llamadas del mismo negocio, para que el proveedor lo reutilice. */
  system: string;
  /**
   * Lo que cambia en cada vuelta (fecha y hora, conversación nueva, nombre de la clienta). El
   * adaptador lo coloca después del último mensaje de la clienta, fuera del prompt del sistema.
   */
  turnContext: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  /** JSON Schema de la respuesta final. */
  responseSchema: Record<string, unknown>;
  /**
   * false: el modelo tiene que contestar sin llamar herramientas. La lista de `tools` se manda
   * igual para no invalidar la caché.
   */
  allowTools: boolean;
  signal: AbortSignal;
}

export type LlmStopReason =
  /** Terminó de contestar. */
  | 'end'
  /** Pidió herramientas. */
  | 'tool_calls'
  /** Se cortó por el largo máximo: la salida puede estar incompleta. */
  | 'max_tokens'
  /** El proveedor se negó a contestar. */
  | 'refusal'
  | 'other';

export interface LlmUsage {
  /** Tokens de entrada que no salieron de la caché. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  /** Para reenviar al modelo en la siguiente llamada de la vuelta. */
  assistantTurn: AssistantTurn;
  toolCalls: LlmToolCall[];
  /** El texto final (JSON con la forma de `responseSchema`). */
  text: string;
  stopReason: LlmStopReason;
  usage: LlmUsage;
  model: string;
}

export interface LlmClient {
  /**
   * Una llamada al modelo. Los errores del proveedor (red, límites, claves) suben tal cual: la
   * tarea se reintenta (6.7) y nunca se disfrazan de respuesta.
   */
  complete(request: LlmRequest): Promise<LlmResponse>;
}
