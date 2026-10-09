import { z } from 'zod';
import { listUpcomingCustomerAppointments } from '../../scheduling/customer-appointments.js';
import { formatShortSlot, truncateText } from '../format.js';
import {
  describeChangeDeadline,
  loadAppointmentSettings,
  summarizeAppointment,
} from './appointment-summary.js';
import { choiceIds } from './choice-ids.js';
import { MAX_LIST_ROWS, MAX_OPTION_DESCRIPTION_LENGTH, type AgentTool } from './tool.js';

/** [S] Cuántos turnos futuros se listan (6.4): los que entran en una lista de WhatsApp. */
export const MAX_LISTED_APPOINTMENTS = MAX_LIST_ROWS;

const input = z.object({});

/**
 * `listar_turnos_de_la_clienta()` (6.4): los turnos futuros de quien escribe que ocupan horario,
 * del más cercano al más lejano. La clienta y el negocio salen del contexto del servidor (regla 2):
 * el modelo no puede pedir los turnos de otra persona. Cada turno se ofrece como opción para elegir.
 */
export const listAppointmentsTool: AgentTool<z.infer<typeof input>> = {
  name: 'listar_turnos_de_la_clienta',
  description:
    'Lista los turnos futuros de la clienta que escribe (hasta 10, del más cercano al más lejano), con su estado, ' +
    'la seña y hasta cuándo se pueden cancelar o reprogramar sin costo. Usala para identificar de qué turno habla ' +
    'cuando quiere cancelar o reprogramar. Cada turno trae su turnoId, que es el que se pasa a cancelar_turno y ' +
    'reprogramar_turno, y los ids del servicio y de la profesional para consultar la disponibilidad al ' +
    'reprogramar. Si tiene varios y no queda claro cuál, ofrecelos para que elija. Solo muestra los turnos de ' +
    'la clienta que escribe.',
  input,
  async run(_input, ctx) {
    ctx.signal.throwIfAborted();
    const { db, tenantId, customerId, now, timeZone } = ctx;

    const settings = await loadAppointmentSettings(db, tenantId);
    const upcoming = await listUpcomingCustomerAppointments(db, {
      tenantId,
      customerId,
      now,
      limit: MAX_LISTED_APPOINTMENTS,
    });
    if (upcoming.length === 0) {
      return {
        content: { turnos: [], mensaje: 'La clienta no tiene turnos próximos.' },
        options: [],
      };
    }

    const summaryContext = { now, timeZone, settings };
    return {
      content: {
        turnos: upcoming.map((appointment) => ({
          ...summarizeAppointment(appointment, summaryContext),
          // Para reprogramar: se consulta la disponibilidad con el mismo servicio y la misma profesional.
          servicioId: appointment.serviceId,
          profesionalId: appointment.professionalId,
          cancelarOReprogramarSinCostoHasta: describeChangeDeadline(appointment, summaryContext),
        })),
      },
      options: upcoming.map((appointment) => ({
        id: choiceIds.appointment(appointment.id),
        title: formatShortSlot(appointment.start, timeZone),
        description: truncateText(
          `${appointment.serviceName} con ${appointment.professionalName}`,
          MAX_OPTION_DESCRIPTION_LENGTH,
        ),
      })),
    };
  },
};
