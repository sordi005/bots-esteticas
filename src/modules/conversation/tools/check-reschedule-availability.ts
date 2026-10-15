import { holdsSchedule } from '../../scheduling/availability.js';
import { findCustomerAppointment, type CustomerAppointment } from '../../scheduling/customer-appointments.js';
import { rescheduleAvailabilityInput, type RescheduleAvailabilityInput } from './availability-input.js';
import { searchAvailability } from './availability-search.js';
import type { AgentTool, ToolContext, ToolResult } from './tool.js';

const failure = (motivo: string, mensaje: string): { failure: ToolResult } => ({
  failure: { content: { motivo, mensaje }, options: [], isError: true },
});

/**
 * El turno que se quiere mover, verificado: tiene que ser de la clienta que escribe (regla 2) y
 * todavía ocupar horario. Si no, el error que se le devuelve al modelo.
 */
export async function loadAppointmentToMove(
  ctx: ToolContext,
  appointmentId: string,
): Promise<{ appointment: CustomerAppointment } | { failure: ToolResult }> {
  const { db, tenantId, customerId, now } = ctx;

  const appointment = await findCustomerAppointment(db, { tenantId, customerId, appointmentId });
  if (!appointment) {
    return failure(
      'turno_no_encontrado',
      'No encontré ese turno entre los de la clienta. Mirá sus turnos con listar_turnos_de_la_clienta.',
    );
  }
  if (!holdsSchedule({ status: appointment.status, depositExpiresAt: appointment.deposit?.expiresAt ?? null }, now)) {
    return failure('turno_no_activo', 'Ese turno ya no está activo, así que no se puede reprogramar.');
  }
  return { appointment };
}

/**
 * `consultar_horarios_para_reprogramar(turno_id, desde, hasta, franja?, despues_de?)` (6.4, 4.6,
 * decisión 28): los horarios libres para MOVER un turno de la clienta. Son del servicio y de la
 * profesional del turno, con su duración y su margen, sin contar al propio turno como ocupado, y con
 * ids `reprogramar:<turno>:<inicio>` que sirven para `reprogramar_turno`. No tiene parámetros de
 * servicio ni de profesional: salen del turno, que tiene que ser de la clienta que escribe.
 */
export const checkRescheduleAvailabilityTool: AgentTool<RescheduleAvailabilityInput> = {
  name: 'consultar_horarios_para_reprogramar',
  description:
    'Devuelve los horarios libres para MOVER un turno que la clienta ya tiene, entre dos fechas (hasta 7 días ' +
    'por consulta, fechas locales AAAA-MM-DD). Solo pasale el turno_id y las fechas: el servicio y la profesional ' +
    'son los del turno, y no hay que mandarlos. Opcional: una franja (manana, tarde, noche). Los horarios vienen ' +
    'ya elegidos y escritos ("viernes 9/10 15:30"): ofrecelos tal cual, sin cambiar ni inventar horarios. Sus ids ' +
    'sirven para reprogramar_turno, no para crear_reserva. Si hayMas es true podés ofrecer "Ver otros horarios": ' +
    'al elegirlo, volvé a llamar con el mismo turno_id y despues_de. Si un día aparece en diasCerrados, explicale ' +
    'el motivo a la clienta. Los horarios ofrecidos están separados entre sí: si la clienta pregunta por una hora ' +
    'puntual que no está entre ellos, no la des por ocupada, verificala con consultar_hora_para_reprogramar. ' +
    'Solo consulta turnos de la clienta que escribe. Es únicamente para mover un turno que ya existe: para ' +
    'reservar uno nuevo usá consultar_disponibilidad.',
  input: rescheduleAvailabilityInput,
  async run(input, ctx) {
    ctx.signal.throwIfAborted();
    // El servicio y la profesional salen del turno: nunca de lo que escribió el modelo.
    const loaded = await loadAppointmentToMove(ctx, input.turno_id);
    if ('failure' in loaded) return loaded.failure;
    const { appointment } = loaded;

    return searchAvailability(
      {
        serviceId: appointment.serviceId,
        professionalId: appointment.professionalId,
        appointment,
        desde: input.desde,
        hasta: input.hasta,
        franja: input.franja,
        despuesDe: input.despues_de,
      },
      ctx,
    );
  },
};
