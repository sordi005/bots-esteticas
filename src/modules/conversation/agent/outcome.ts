/**
 * Cómo terminó una respuesta del agente (tabla `agent_runs`, sección 7.2). Lista cerrada: sirve
 * para ver de un vistazo cuántas veces el asistente no pudo contestar bien.
 */
export const agentOutcomes = [
  /** Contestó con la respuesta del modelo. */
  'replied',
  /** Contestó, pero llegó al tope de herramientas y se le pidió una respuesta sin ellas (9.1). */
  'tool_limit',
  /** El proveedor se negó a contestar: se envió la frase fija. */
  'fallback_refusal',
  /** La respuesta se cortó por el largo máximo: se envió la frase fija. */
  'fallback_max_tokens',
  /** La salida no tenía la forma pedida: se envió la frase fija. */
  'fallback_invalid_output',
  /** La clienta pasó el límite de mensajes por hora: no se llamó al modelo ni se contestó (9.1). */
  'rate_limited',
] as const;

export type AgentOutcome = (typeof agentOutcomes)[number];
