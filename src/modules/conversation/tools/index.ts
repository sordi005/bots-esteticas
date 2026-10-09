import { businessInfoTool } from './business-info.js';
import { checkAvailabilityTool } from './check-availability.js';
import { searchServicesTool } from './search-services.js';
import type { AgentTool } from './tool.js';

export { resolveChoice, type ResolvedChoice } from './choices.js';
export { runTool } from './tool.js';
export type { AgentTool, OfferableOption, ToolContext, ToolResult } from './tool.js';

/**
 * Las herramientas de consulta (H7): solo leen. Las que escriben (reservar, derivar) son de H8.
 * El nombre es lo que ve el modelo y lo que piden las evaluaciones (6.4).
 */
export const consultationTools: AgentTool<unknown>[] = [
  searchServicesTool,
  businessInfoTool,
  checkAvailabilityTool,
];
