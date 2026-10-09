import { businessInfoTool } from './business-info.js';
import { cancelAppointmentTool } from './cancel-appointment.js';
import { checkAvailabilityTool } from './check-availability.js';
import { createBookingTool } from './create-booking.js';
import { handOffTool } from './hand-off.js';
import { listAppointmentsTool } from './list-appointments.js';
import { rescheduleAppointmentTool } from './reschedule-appointment.js';
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
 * Todas las herramientas del agente: las de consulta más las que cambian cosas (H8): reservar,
 * listar, reprogramar y cancelar turnos, y derivar a una persona. El orden es el de la tabla de 6.4.
 */
export const agentTools: AgentTool<unknown>[] = [
  ...consultationTools,
  createBookingTool,
  listAppointmentsTool,
  rescheduleAppointmentTool,
  cancelAppointmentTool,
  handOffTool,
];
