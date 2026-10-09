import { businessInfoTool } from './business-info.js';
import { checkAvailabilityTool } from './check-availability.js';
import { handOffTool } from './hand-off.js';
import { searchServicesTool } from './search-services.js';
import type { AgentTool } from './tool.js';

export { resolveChoice, type ResolvedChoice } from './choices.js';
export { runTool } from './tool.js';
export type { AgentTool, OfferableOption, ToolContext, ToolResult } from './tool.js';

/**
 * Las herramientas de consulta (H7): solo leen.
 * El nombre es lo que ve el modelo y lo que piden las evaluaciones (6.4).
 */
export const consultationTools: AgentTool<unknown>[] = [
  searchServicesTool,
  businessInfoTool,
  checkAvailabilityTool,
];

/**
 * Todas las herramientas del agente: las de consulta más las que cambian cosas. En H8 se suma
 * `derivar_a_persona`; las de turnos llegan en la etapa B.
 */
export const agentTools: AgentTool<unknown>[] = [...consultationTools, handOffTool];
