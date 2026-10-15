import { and, eq } from 'drizzle-orm';
import { listVisibleServices } from '../../catalog/queries.js';
import { professionals } from '../../catalog/schema.js';
import { loadAvailabilityContext, loadRescheduleContext } from '../../scheduling/availability-context.js';
import { occupiesSchedule } from '../../scheduling/appointment-state-machine.js';
import { checkSlot } from '../../scheduling/booking.js';
import { holdsSchedule } from '../../scheduling/availability.js';
import { findCustomerAppointment, type CustomerAppointment } from '../../scheduling/customer-appointments.js';
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
  /**
   * La clienta eligió un horario nuevo para MOVER un turno suyo (decisión 28): elegirlo ya es la
   * confirmación de reprogramar. Se volvió a validar sin contar al propio turno como ocupado.
   */
  | ({
      tipo: 'reprogramar';
      /** El turno que se mueve, escrito ("lunes 5/10 9:00"). */
      turnoTexto: string;
      /** Inicio del horario nuevo en UTC, ISO 8601. */
      inicio: string;
      /** El horario nuevo, escrito. */
      texto: string;
      duracionMinutos: number;
      /** Se volvió a verificar ahora: false si lo tomaron, no es válido o el turno ya no ocupa horario. */
      sigueLibre: boolean;
    } & Omit<ResolvedAppointment, 'texto'>)
  /** "Ver otros horarios" de una reprogramación: sigue en modo reprogramar, con el turno. */
  | {
      tipo: 'ver_mas_reprogramar';
      turnoId: string;
      turnoTexto: string;
      ocupaHorario: boolean;
      /** Inicio (UTC, ISO 8601) del último horario que ya se ofreció. */
      despuesDe: string;
    }
  | { tipo: 'desconocido' };

const UNKNOWN: ResolvedChoice = { tipo: 'desconocido' };

async function findProfessional(db: Queryable, tenantId: string, professionalId: string) {
  const [professional] = await db
    .select({ id: professionals.id, name: professionals.name })
    .from(professionals)
    .where(and(eq(professionals.tenantId, tenantId), eq(professionals.id, professionalId)));
  return professional;
}

function toResolvedAppointment(appointment: CustomerAppointment, timeZone: string): ResolvedAppointment {
  return {
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
        ...toResolvedAppointment(appointment, timeZone),
      };
    }

    case 'reschedule': {
      // Lo mismo: el turno es de ESTA clienta. Y el horario nuevo se valida como lo valida
      // `rescheduleAppointment` (mismo servicio, misma profesional, su duración y su margen), así un
      // horario que sigue libre acá no es rechazado después.
      const appointment = await findCustomerAppointment(db, {
        tenantId,
        customerId,
        appointmentId: choice.appointmentId,
      });
      if (!appointment) return UNKNOWN;
      const { start } = choice;
      const context = await loadRescheduleContext(db, {
        tenantId,
        appointment,
        window: { start, end: new Date(start.getTime() + MINUTE_MS) },
        now,
      });
      const schedule = context?.query.professionals.find((p) => p.id === appointment.professionalId);
      const holdsTheSlot = holdsSchedule(
        { status: appointment.status, depositExpiresAt: appointment.deposit?.expiresAt ?? null },
        now,
      );
      const { texto: turnoTexto, ...resolved } = toResolvedAppointment(appointment, timeZone);
      return {
        tipo: 'reprogramar',
        ...resolved,
        turnoTexto,
        inicio: start.toISOString(),
        texto: formatLocalSlot(start, timeZone),
        duracionMinutos: appointment.durationMinutes,
        sigueLibre: holdsTheSlot && context !== null && schedule !== undefined && checkSlot(context, schedule, start) === 'ok',
      };
    }

    case 'more_reschedule': {
      const appointment = await findCustomerAppointment(db, {
        tenantId,
        customerId,
        appointmentId: choice.appointmentId,
      });
      if (!appointment) return UNKNOWN;
      return {
        tipo: 'ver_mas_reprogramar',
        turnoId: appointment.id,
        turnoTexto: formatLocalSlot(appointment.start, timeZone),
        ocupaHorario: occupiesSchedule(appointment.status),
        despuesDe: choice.after.toISOString(),
      };
    }
  }
}
