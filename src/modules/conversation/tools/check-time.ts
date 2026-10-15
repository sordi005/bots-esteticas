import { timeQueryInput, type TimeQueryInput } from './availability-input.js';
import { checkTime } from './time-check.js';
import type { AgentTool } from './tool.js';

/**
 * `consultar_hora(servicio_id, fecha, hora, profesional_id?)` (6.4, decisión 29): si una hora puntual está
 * libre para RESERVAR. La fecha y la hora son locales del negocio y las convierte el código. La valida con la
 * misma lógica que la reserva; si está libre la ofrece como opción, y si no, dice el motivo y los horarios
 * libres más cercanos.
 *
 * Es una herramienta aparte y no un parámetro `hora` de `consultar_disponibilidad`: un parámetro opcional que
 * cambia lo que hace la herramienta lo omite el modelo (decisión 29).
 */
export const checkTimeTool: AgentTool<TimeQueryInput> = {
  name: 'consultar_hora',
  description:
    'Dice si una hora puntual está libre para reservar un turno nuevo. Usala cuando la clienta pregunta por una ' +
    'hora puntual que no está entre las que ofreciste ("¿y a las 16:30?", "¿a las 20 hs no hay?"). Mandá el ' +
    'servicio_id, la fecha local AAAA-MM-DD y la hora local HH:MM tal cual la dijo (24 horas, sin convertir). ' +
    'Opcional: una profesional puntual (solo si la clienta la pidió). Si libre es true, ofrecé el horario con su ' +
    'opcionId. Si libre es false, el motivo y el mensaje dicen por qué (ocupado, fuera de horario, fuera de la ' +
    'grilla, sin anticipación, feriado…) y horariosCercanos trae los horarios libres más cercanos: explicale ' +
    'el motivo tal cual y ofrecé esos. Nunca digas que un horario está ocupado, que se ocupó o que no existe ' +
    'si esta herramienta no lo dijo. Es solo para reservar: para mover un turno que la clienta ya tiene usá ' +
    'consultar_hora_para_reprogramar.',
  input: timeQueryInput,
  run: (input, ctx) =>
    checkTime(
      {
        serviceId: input.servicio_id,
        professionalId: input.profesional_id,
        appointment: undefined,
        fecha: input.fecha,
        hora: input.hora,
      },
      ctx,
    ),
};
