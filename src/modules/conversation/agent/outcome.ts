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
  /** El modelo falló dos veces seguidas: el código derivó a una persona y se envió la frase fija (4.8, 8.5). */
  'handoff_not_understood',
  /**
   * La respuesta decía que una persona iba a atender a la clienta (`derivada=true`) y no se derivó, ni
   * después de hacérselo notar al modelo: se envió la frase fija (6.4, 8.5). Cuenta como intento fallido.
   * Va al final porque Postgres agrega los valores nuevos del enum al final.
   */
  'fallback_unfulfilled_handoff',
] as const;

export type AgentOutcome = (typeof agentOutcomes)[number];
