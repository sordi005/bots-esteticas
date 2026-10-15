import { availabilityInput, type AvailabilityInput } from './availability-input.js';
import { searchAvailability } from './availability-search.js';
import type { AgentTool } from './tool.js';

/**
 * `consultar_disponibilidad(servicio, profesional?, desde, hasta, franja?)` (6.4). Las fechas son
 * locales del negocio. El código calcula los horarios, elige cuáles ofrecer (4.3) y los
 * escribe; el modelo solo los cuenta. Si el servicio no es visible o requiere consulta previa,
 * no devuelve horarios: devuelve el motivo.
 *
 * Es para RESERVAR: sus ids son `horario:...`. Mover un turno que la clienta ya tiene es otra
 * herramienta (`consultar_horarios_para_reprogramar`), porque un parámetro opcional que cambia lo que
 * hace la herramienta lo omite el modelo, y con él los que eran necesarios (decisión 28).
 */
export const checkAvailabilityTool: AgentTool<AvailabilityInput> = {
  name: 'consultar_disponibilidad',
  description:
    'Devuelve los horarios libres para un servicio entre dos fechas (hasta 7 días por consulta, ' +
    'fechas locales AAAA-MM-DD). Opcional: una profesional puntual (solo si la clienta la pidió) y ' +
    'una franja (manana, tarde, noche). Los horarios vienen ya elegidos y escritos ("viernes 9/10 ' +
    '15:30"): ofrecelos tal cual, sin cambiar ni inventar horarios. Si hayMas es true podés ofrecer ' +
    '"Ver otros horarios": al elegirlo, volvé a llamar con despues_de. Si el servicio requiere ' +
    'consulta previa no hay horarios: ofrecé que lo vea una persona. Si un día aparece en ' +
    'diasCerrados, explicale el motivo a la clienta. Los horarios ofrecidos están separados entre sí: si la ' +
    'clienta pregunta por una hora puntual que no está entre ellos, no la des por ocupada, verificala con ' +
    'consultar_hora. Es para reservar un turno nuevo: para mover un turno que la clienta ya tiene usá ' +
    'consultar_horarios_para_reprogramar.',
  input: availabilityInput,
  run: (input, ctx) =>
    searchAvailability(
      {
        serviceId: input.servicio_id,
        professionalId: input.profesional_id,
        appointment: undefined,
        desde: input.desde,
        hasta: input.hasta,
        franja: input.franja,
        despuesDe: input.despues_de,
      },
      ctx,
    ),
};
