import { rescheduleTimeQueryInput, type RescheduleTimeQueryInput } from './availability-input.js';
import { loadAppointmentToMove } from './check-reschedule-availability.js';
import { checkTime } from './time-check.js';
import type { AgentTool } from './tool.js';

/**
 * `consultar_hora_para_reprogramar(turno_id, fecha, hora)` (6.4, decisión 29): si una hora puntual está libre
 * para MOVER un turno de la clienta. Es lo mismo que `consultar_hora`, pero con el servicio, la profesional, la
 * duración y el margen del turno, sin contar al propio turno como ocupado, y con ids `reprogramar:<turno>:<inicio>`
 * que sirven para `reprogramar_turno`. El turno tiene que ser de la clienta que escribe. Si la hora pedida es la
 * que el turno ya tiene, lo dice.
 */
export const checkRescheduleTimeTool: AgentTool<RescheduleTimeQueryInput> = {
  name: 'consultar_hora_para_reprogramar',
  description:
    'Dice si una hora puntual está libre para MOVER un turno que la clienta ya tiene. Usala cuando la clienta ' +
    'pregunta por una hora puntual que no está entre las que ofreciste para mover el turno ("¿y a las 16:30?"). ' +
    'Solo pasale el turno_id, la fecha local AAAA-MM-DD y la hora local HH:MM tal cual la dijo (24 horas, sin ' +
    'convertir): el servicio y la profesional son los del turno, y no hay que mandarlos. Si libre es true, ofrecé el ' +
    'horario con su opcionId: sirve para reprogramar_turno, no para crear_reserva. Si libre es false, el motivo y el ' +
    'mensaje dicen por qué (ocupado, fuera de horario, fuera de la grilla, sin anticipación, feriado, o que ya es la ' +
    'hora del turno) y horariosCercanos trae los horarios libres más cercanos: explicale el motivo tal cual y ' +
    'ofrecé esos. Nunca digas que un horario está ocupado, que se ocupó o que no existe si esta herramienta no lo ' +
    'dijo. Solo consulta turnos de la clienta que escribe. Es únicamente para mover un turno que ya existe: para ' +
    'una hora de un turno nuevo usá consultar_hora.',
  input: rescheduleTimeQueryInput,
  async run(input, ctx) {
    ctx.signal.throwIfAborted();
    // El servicio y la profesional salen del turno: nunca de lo que escribió el modelo.
    const loaded = await loadAppointmentToMove(ctx, input.turno_id);
    if ('failure' in loaded) return loaded.failure;
    const { appointment } = loaded;

    return checkTime(
      {
        serviceId: appointment.serviceId,
        professionalId: appointment.professionalId,
        appointment,
        fecha: input.fecha,
        hora: input.hora,
      },
      ctx,
    );
  },
};
