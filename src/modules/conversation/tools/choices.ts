import { and, eq } from 'drizzle-orm';
import { listVisibleServices } from '../../catalog/queries.js';
import { professionals } from '../../catalog/schema.js';
import { loadAvailabilityContext } from '../../scheduling/availability-context.js';
import { occupiesSchedule } from '../../scheduling/appointment-state-machine.js';
import { checkSlot } from '../../scheduling/booking.js';
import { findCustomerAppointment } from '../../scheduling/customer-appointments.js';
import type { Queryable } from '../../../shared/db.js';
import { formatLocalSlot } from '../format.js';
import { describeAppointmentStatus } from './appointment-content.js';
import { parseChoiceId } from './choice-ids.js';
import { describeDuration, describePrice } from './service-content.js';
import type { ToolContext } from './tool.js';

/**
 * Elecciones estructuradas (5.3): cuando la clienta toca un botón o una fila de lista,
 * WhatsApp devuelve el id que le ofrecimos. El modelo nunca interpreta ese texto: el código
 * lo resuelve acá y lo vuelve a validar contra la base (por ejemplo, que el horario siga libre).
 * Nunca se confía en el id: puede venir de otro negocio, de una conversación vieja o de un
 * mensaje armado a mano.
 */

const MINUTE_MS = 60_000;

export type ChoiceContext = Pick<ToolContext, 'tenantId' | 'customerId' | 'now' | 'timeZone'>;

/** Un turno de la clienta, ya resuelto: lo comparten el turno elegido y el botón "Sí, cancelar". */
interface ResolvedAppointment {
  /** El uuid del turno; el id para las herramientas es `turno:<uuid>`. */
  turnoId: string;
  /** Para consultar la disponibilidad al reprogramar: el mismo servicio y la misma profesional. */
  servicioId: string;
  profesionalId: string;
  servicioNombre: string;
  profesionalNombre: string;
  texto: string;
  /** El estado en español ("confirmado", "pendiente de seña"…). */
  estado: string;
  /** Si todavía ocupa el horario: uno cancelado o vencido ya no se puede cancelar ni reprogramar. */
  ocupaHorario: boolean;
}

export type ResolvedChoice =
  | {
      tipo: 'servicio';
      servicioId: string;
      nombre: string;
      precioTexto: string;
      duracionTexto: string;
      requiereConsultaPrevia: boolean;
    }
  | {
      tipo: 'horario';
      servicioId: string;
      servicioNombre: string;
      profesionalId: string;
      profesionalNombre: string;
      /** Inicio en UTC, ISO 8601. */
      inicio: string;
      texto: string;
      duracionMinutos: number;
      /** Se volvió a verificar ahora: false si lo tomaron, pasó o ya no se puede agendar. */
      sigueLibre: boolean;
    }
  | {
      tipo: 'ver_mas';
      servicioId: string;
      /** Null = sin profesional pedida. */
      profesionalId: string | null;
      /** Inicio (UTC, ISO 8601) del último horario que ya se ofreció. */
      despuesDe: string;
    }
  /** La clienta eligió uno de sus turnos (para cancelarlo o reprogramarlo). */
  | ({ tipo: 'turno' } & ResolvedAppointment)
  /** La clienta tocó "Sí, cancelar": confirmó cancelar este turno. */
  | ({ tipo: 'cancelar' } & ResolvedAppointment)
  | { tipo: 'desconocido' };

const UNKNOWN: ResolvedChoice = { tipo: 'desconocido' };

async function findProfessional(db: Queryable, tenantId: string, professionalId: string) {
  const [professional] = await db
    .select({ id: professionals.id, name: professionals.name })
    .from(professionals)
    .where(and(eq(professionals.tenantId, tenantId), eq(professionals.id, professionalId)));
  return professional;
}

export async function resolveChoice(
  db: Queryable,
  ctx: ChoiceContext,
  replyId: string,
): Promise<ResolvedChoice> {
  const choice = parseChoiceId(replyId);
  if (!choice) return UNKNOWN;
  const { tenantId, customerId, now, timeZone } = ctx;

  switch (choice.kind) {
    case 'service': {
      const service = (await listVisibleServices(db, tenantId)).find((s) => s.id === choice.serviceId);
      if (!service) return UNKNOWN;
      return {
        tipo: 'servicio',
        servicioId: service.id,
        nombre: service.name,
        precioTexto: describePrice(service),
        duracionTexto: describeDuration(service.durationMinutes, service.professionals),
        requiereConsultaPrevia: service.requiresConsultation,
      };
    }

    case 'slot': {
      const { serviceId, professionalId, start } = choice;
      const professional = await findProfessional(db, tenantId, professionalId);
      const context = await loadAvailabilityContext(db, {
        tenantId,
        serviceId,
        professionalIds: [professionalId],
        window: { start, end: new Date(start.getTime() + MINUTE_MS) },
        now,
      });
      if (!professional || !context) return UNKNOWN;

      const { service } = context;
      const schedule = context.query.professionals.find((p) => p.id === professionalId);
      // Lo mismo que valida la reserva: el horario sigue libre y el servicio se puede agendar.
      const bookable = service.visible && !service.requiresConsultation && schedule !== undefined;
      return {
        tipo: 'horario',
        servicioId: service.id,
        servicioNombre: service.name,
        profesionalId: professional.id,
        profesionalNombre: professional.name,
        inicio: start.toISOString(),
        texto: formatLocalSlot(start, timeZone),
        duracionMinutos: schedule?.durationOverrideMinutes ?? service.durationMinutes,
        sigueLibre: bookable && checkSlot(context, schedule, start) === 'ok',
      };
    }

    case 'more': {
      const { serviceId, professionalId, after } = choice;
      const service = (await listVisibleServices(db, tenantId)).find((s) => s.id === serviceId);
      if (!service) return UNKNOWN;
      if (professionalId && !(await findProfessional(db, tenantId, professionalId))) return UNKNOWN;
      return {
        tipo: 'ver_mas',
        servicioId: service.id,
        profesionalId: professionalId,
        despuesDe: after.toISOString(),
      };
    }

    case 'appointment':
    case 'cancel': {
      // El turno tiene que ser de ESTA clienta, no solo del negocio: un id de otra persona
      // (o de una conversación vieja) no resuelve nada (regla 2).
      const appointment = await findCustomerAppointment(db, {
        tenantId,
        customerId,
        appointmentId: choice.appointmentId,
      });
      if (!appointment) return UNKNOWN;
      return {
        tipo: choice.kind === 'appointment' ? 'turno' : 'cancelar',
        turnoId: appointment.id,
        servicioId: appointment.serviceId,
        profesionalId: appointment.professionalId,
        servicioNombre: appointment.serviceName,
        profesionalNombre: appointment.professionalName,
        texto: formatLocalSlot(appointment.start, timeZone),
        estado: describeAppointmentStatus(appointment.status),
        ocupaHorario: occupiesSchedule(appointment.status),
      };
    }
  }
}
