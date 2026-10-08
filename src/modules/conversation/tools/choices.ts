import { and, eq } from 'drizzle-orm';
import { listVisibleServices } from '../../catalog/queries.js';
import { professionals } from '../../catalog/schema.js';
import { loadAvailabilityContext } from '../../scheduling/availability-context.js';
import { checkSlot } from '../../scheduling/booking.js';
import type { Queryable } from '../../../shared/db.js';
import { formatLocalSlot } from '../format.js';
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

export type ChoiceContext = Pick<ToolContext, 'tenantId' | 'now' | 'timeZone'>;

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
  const { tenantId, now, timeZone } = ctx;

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
  }
}
