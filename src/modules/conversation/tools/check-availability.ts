import { and, eq, inArray } from 'drizzle-orm';
import { listHolidays } from '../../catalog/queries.js';
import { professionals } from '../../catalog/schema.js';
import { customers } from '../../customers/schema.js';
import { loadAvailabilityContext } from '../../scheduling/availability-context.js';
import {
  findAvailableSlots,
  pickFirstAvailable,
  type AvailabilityQuery,
  type Slot,
} from '../../scheduling/availability.js';
import {
  MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES,
  pickSpreadSlots,
} from '../../scheduling/slot-selection.js';
import { addDaysToLocalDate, instantToLocal, localDateTimeToInstant } from '../../../shared/time-zone.js';
import { formatLocalDate, formatLocalSlot, formatShortSlot, truncateText } from '../format.js';
import {
  availabilityInput,
  periodOfDay,
  type AvailabilityInput,
  type DayPeriod,
} from './availability-input.js';
import { choiceIds } from './choice-ids.js';
import {
  MAX_LIST_ROWS,
  MAX_OPTION_DESCRIPTION_LENGTH,
  type AgentTool,
  type OfferableOption,
  type ToolResult,
} from './tool.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const SEE_MORE_TITLE = 'Ver otros horarios';

interface Filters {
  professionalId: string | undefined;
  period: DayPeriod | undefined;
  preferredProfessionalId: string | null;
  after: Date | undefined;
}

/**
 * Los horarios libres que cumplen lo pedido, uno por horario (con la primera profesional
 * disponible si la clienta no eligió: la preferida y después el orden fijo, 4.2).
 */
function candidateSlots(query: AvailabilityQuery, filters: Filters): Slot[] {
  const team = filters.professionalId
    ? query.professionals.filter((professional) => professional.id === filters.professionalId)
    : query.professionals;

  const free = findAvailableSlots({ ...query, professionals: team }).filter((slot) => {
    const inPeriod =
      !filters.period || periodOfDay(instantToLocal(slot.start, query.timeZone).minutesOfDay) === filters.period;
    const afterCursor = !filters.after || slot.start.getTime() > filters.after.getTime();
    return inPeriod && afterCursor;
  });

  return pickFirstAvailable(free, {
    professionalOrder: query.professionals.map((professional) => professional.id),
    preferredProfessionalId: filters.preferredProfessionalId,
  });
}

/**
 * `consultar_disponibilidad(servicio, profesional?, desde, hasta, franja?)` (6.4). Las fechas son
 * locales del negocio. El código calcula los horarios, elige cuáles ofrecer (4.3) y los
 * escribe; el modelo solo los cuenta. Si el servicio no es visible o requiere consulta previa,
 * no devuelve horarios: devuelve el motivo.
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
    'diasCerrados, explicale el motivo a la clienta.',
  input: availabilityInput,
  async run(input, ctx) {
    ctx.signal.throwIfAborted();
    const { db, tenantId, now, timeZone } = ctx;

    const rangeStart = localDateTimeToInstant(input.desde, '00:00', timeZone);
    const rangeEnd = localDateTimeToInstant(addDaysToLocalDate(input.hasta, 1), '00:00', timeZone);

    const context = await loadAvailabilityContext(db, {
      tenantId,
      serviceId: input.servicio_id,
      window: { start: rangeStart, end: rangeEnd },
      now,
    });
    if (!context) {
      return {
        content: {
          motivo: 'servicio_no_encontrado',
          mensaje: 'Ese servicio no existe en el catálogo: buscalo con buscar_servicios',
        },
        options: [],
        isError: true,
      };
    }

    const { service, settings, query } = context;
    const serviceRef = { id: service.id, nombre: service.name };
    if (!service.visible) {
      return {
        content: {
          servicio: serviceRef,
          motivo: 'servicio_no_disponible',
          mensaje: 'Este servicio no se agenda por este medio: ofrecé que lo vea una persona',
          horarios: [],
        },
        options: [],
      };
    }
    if (service.requiresConsultation) {
      return {
        content: {
          servicio: serviceRef,
          requiereConsulta: true,
          motivo: 'requiere_consulta_previa',
          mensaje: 'Este servicio requiere una consulta previa: no se agenda directo. Ofrecé que lo vea una persona',
          horarios: [],
        },
        options: [],
      };
    }

    const team = query.professionals;
    const names = new Map(
      (
        await db
          .select({ id: professionals.id, name: professionals.name })
          .from(professionals)
          .where(
            and(
              eq(professionals.tenantId, tenantId),
              inArray(
                professionals.id,
                team.map((professional) => professional.id),
              ),
            ),
          )
      ).map((row) => [row.id, row.name]),
    );
    const nameOf = (professionalId: string) => names.get(professionalId) ?? '';

    const requested = input.profesional_id
      ? team.find((professional) => professional.id === input.profesional_id)
      : undefined;
    if (input.profesional_id && !requested) {
      return {
        content: {
          servicio: serviceRef,
          motivo: 'profesional_no_hace_el_servicio',
          mensaje: 'Esa profesional no hace este servicio (o no existe)',
          profesionalesQueLoHacen: team.map((professional) => ({
            id: professional.id,
            nombre: nameOf(professional.id),
          })),
        },
        options: [],
        isError: true,
      };
    }

    const [customer] = input.profesional_id
      ? []
      : await db
          .select({ preferred: customers.preferredProfessionalId })
          .from(customers)
          .where(and(eq(customers.tenantId, tenantId), eq(customers.id, ctx.customerId)));
    const filters: Filters = {
      professionalId: requested?.id,
      period: input.franja,
      preferredProfessionalId: customer?.preferred ?? null,
      after: input.despues_de ? new Date(input.despues_de) : undefined,
    };

    // Cuántas opciones: las del negocio, más "ver otros", sin pasar las 10 filas de una lista.
    const { chosen, hasMore } = pickSpreadSlots(candidateSlots(query, filters), {
      count: Math.min(settings.slotsOffered, MAX_LIST_ROWS - 1),
      minGapMinutes: MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES,
    });

    const entryOf = (slot: Slot) => {
      const id = choiceIds.slot(service.id, slot.professionalId, slot.start);
      return {
        content: {
          opcionId: id,
          texto: formatLocalSlot(slot.start, timeZone),
          profesional: nameOf(slot.professionalId),
          profesionalId: slot.professionalId,
          inicio: slot.start.toISOString(),
          duracionMinutos: (slot.end.getTime() - slot.start.getTime()) / MINUTE_MS,
        },
        option: {
          id,
          title: formatShortSlot(slot.start, timeZone),
          description: truncateText(`con ${nameOf(slot.professionalId)}`, MAX_OPTION_DESCRIPTION_LENGTH),
        } satisfies OfferableOption,
      };
    };

    const entries = chosen.map(entryOf);

    // Un feriado en que el negocio no trabaja y que ningún horario especial abre.
    const closedDays = settings.worksOnHolidays
      ? []
      : (await listHolidays(db, input.desde, input.hasta)).filter(
          (holiday) => !opensWithSpecialHours(holiday.date, query, requested?.id, timeZone),
        );

    const content: Record<string, unknown> = {
      servicio: serviceRef,
      desde: input.desde,
      hasta: input.hasta,
      ...(input.franja ? { franja: input.franja } : {}),
      horarios: entries.map((entry) => entry.content),
      hayMas: hasMore,
      ...(closedDays.length > 0
        ? {
            diasCerrados: closedDays.map((holiday) => ({
              fecha: formatLocalDate(holiday.date),
              motivo: `feriado: ${holiday.name}`,
            })),
          }
        : {}),
    };

    if (chosen.length > 0) {
      const last = chosen[chosen.length - 1];
      const options: OfferableOption[] = entries.map((entry) => entry.option);
      if (hasMore && last) {
        options.push({ id: choiceIds.more(service.id, requested?.id ?? null, last.start), title: SEE_MORE_TITLE });
      }
      return { content, options } satisfies ToolResult;
    }

    // Sin lugar: si el rango pasa del límite de anticipación se avisa, y si no, se busca lo próximo.
    content.mensaje = 'No hay horarios libres en ese rango';
    const latestBookable = new Date(now.getTime() + settings.maxBookingAdvanceDays * DAY_MS);
    if (input.hasta > instantToLocal(latestBookable, timeZone).date) {
      content.reservableHasta = formatLocalDate(instantToLocal(latestBookable, timeZone).date);
    }

    const horizonEnd = new Date(now.getTime() + (settings.maxBookingAdvanceDays + 1) * DAY_MS);
    if (horizonEnd.getTime() > rangeEnd.getTime()) {
      const later = await loadAvailabilityContext(db, {
        tenantId,
        serviceId: service.id,
        window: { start: rangeEnd, end: horizonEnd },
        now,
      });
      const next = later ? candidateSlots(later.query, { ...filters, after: undefined })[0] : undefined;
      if (next) {
        const entry = entryOf(next);
        content.proximoHorario = entry.content;
        return { content, options: [entry.option] };
      }
    }
    return { content, options: [] };
  },
};

/** ¿Algún horario especial (del negocio o de la profesional pedida) abre ese día? */
function opensWithSpecialHours(
  date: string,
  query: AvailabilityQuery,
  professionalId: string | undefined,
  timeZone: string,
): boolean {
  const dayStart = localDateTimeToInstant(date, '00:00', timeZone).getTime();
  const dayEnd = localDateTimeToInstant(addDaysToLocalDate(date, 1), '00:00', timeZone).getTime();
  return query.exceptions.some(
    (exception) =>
      exception.kind === 'special_hours' &&
      (exception.professionalId === null || professionalId === undefined || exception.professionalId === professionalId) &&
      exception.range.start.getTime() < dayEnd &&
      exception.range.end.getTime() > dayStart,
  );
}
