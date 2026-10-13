import { and, eq, inArray } from 'drizzle-orm';
import { listHolidays } from '../../catalog/queries.js';
import { professionals } from '../../catalog/schema.js';
import { customers } from '../../customers/schema.js';
import { loadAvailabilityContext, loadRescheduleContext } from '../../scheduling/availability-context.js';
import {
  findAvailableSlots,
  holdsSchedule,
  pickFirstAvailable,
  type AvailabilityQuery,
  type Slot,
} from '../../scheduling/availability.js';
import { findCustomerAppointment, type CustomerAppointment } from '../../scheduling/customer-appointments.js';
import {
  MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES,
  pickSpreadSlots,
} from '../../scheduling/slot-selection.js';
import { addDaysToLocalDate, instantToLocal, localDateTimeToInstant } from '../../../shared/time-zone.js';
import { formatLocalDate, formatLocalSlot } from '../format.js';
import {
  availabilityInput,
  periodOfDay,
  type AvailabilityInput,
  type DayPeriod,
} from './availability-input.js';
import { choiceIds, parseAppointmentRef } from './choice-ids.js';
import { slotOffer } from './slot-offer.js';
import { MAX_LIST_ROWS, type AgentTool, type OfferableOption, type ToolContext, type ToolResult } from './tool.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const SEE_MORE_TITLE = 'Ver otros horarios';

interface Filters {
  professionalId: string | undefined;
  period: DayPeriod | undefined;
  preferredProfessionalId: string | null;
  after: Date | undefined;
  /** Al reprogramar: el horario en el que el turno ya está, que no tiene sentido ofrecer. */
  excludeStart: Date | undefined;
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
    const isCurrentStart = filters.excludeStart?.getTime() === slot.start.getTime();
    return inPeriod && afterCursor && !isCurrentStart;
  });

  return pickFirstAvailable(free, {
    professionalOrder: query.professionals.map((professional) => professional.id),
    preferredProfessionalId: filters.preferredProfessionalId,
  });
}

/**
 * El turno que se quiere mover (`turno_id`), verificado: tiene que ser de la clienta que escribe
 * (regla 2) y todavía ocupar horario. Si no, el error que se le devuelve al modelo.
 */
async function loadAppointmentToMove(
  ctx: ToolContext,
  input: AvailabilityInput,
): Promise<{ appointment: CustomerAppointment } | { failure: ToolResult }> {
  const { db, tenantId, customerId, now } = ctx;
  const failure = (motivo: string, mensaje: string): { failure: ToolResult } => ({
    failure: { content: { motivo, mensaje }, options: [], isError: true },
  });

  const appointmentId = input.turno_id === undefined ? null : parseAppointmentRef(input.turno_id);
  if (!appointmentId) {
    return failure(
      'id_de_turno_invalido',
      'Ese no es el id de un turno: usá el turnoId que devolvió listar_turnos_de_la_clienta, sin cambiarlo.',
    );
  }
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
  // Reprogramar es el mismo servicio con la misma profesional (4.6): si el modelo manda otros, algo no cerró.
  if (
    (input.servicio_id !== undefined && input.servicio_id !== appointment.serviceId) ||
    (input.profesional_id !== undefined && input.profesional_id !== appointment.professionalId)
  ) {
    return failure(
      'otro_servicio_o_profesional',
      'Reprogramar es con el mismo servicio y la misma profesional del turno: con turno_id no mandes servicio_id ' +
        'ni profesional_id. Si la clienta quiere cambiar de profesional o de servicio, no se hace por acá: ofrecele ' +
        'que lo vea una persona del equipo y, si acepta, derivá con el motivo excepcion en el campo «derivar» de tu respuesta.',
    );
  }
  return { appointment };
}

/**
 * `consultar_disponibilidad(servicio, profesional?, desde, hasta, franja?, turno?)` (6.4). Las
 * fechas son locales del negocio. El código calcula los horarios, elige cuáles ofrecer (4.3) y los
 * escribe; el modelo solo los cuenta. Si el servicio no es visible o requiere consulta previa,
 * no devuelve horarios: devuelve el motivo.
 *
 * Con `turno_id` son los horarios para REPROGRAMAR ese turno (4.6, decisión 28): del mismo servicio
 * con la misma profesional, sin contar al propio turno como ocupado y con su duración y su margen,
 * con ids `reprogramar:` en vez de `horario:`.
 */
export const checkAvailabilityTool: AgentTool<AvailabilityInput> = {
  name: 'consultar_disponibilidad',
  description:
    'Devuelve los horarios libres para un servicio entre dos fechas (hasta 7 días por consulta, ' +
    'fechas locales AAAA-MM-DD). Opcional: una profesional puntual (solo si la clienta la pidió) y ' +
    'una franja (manana, tarde, noche). Los horarios vienen ya elegidos y escritos ("viernes 9/10 ' +
    '15:30"): ofrecelos tal cual, sin cambiar ni inventar horarios. Si hayMas es true podés ofrecer ' +
    '"Ver otros horarios": al elegirlo, volvé a llamar con despues_de. Para REPROGRAMAR un turno de la ' +
    'clienta no mandes servicio_id: pasá turno_id y los horarios que devuelve son para mover ese turno, ' +
    'del mismo servicio con la misma profesional (sus ids sirven para reprogramar_turno, no para crear_reserva). ' +
    'Si el servicio requiere consulta previa no hay horarios: ofrecé que lo vea una persona. Si un día ' +
    'aparece en diasCerrados, explicale el motivo a la clienta.',
  input: availabilityInput,
  async run(input, ctx) {
    ctx.signal.throwIfAborted();
    const { db, tenantId, now, timeZone } = ctx;

    const rangeStart = localDateTimeToInstant(input.desde, '00:00', timeZone);
    const rangeEnd = localDateTimeToInstant(addDaysToLocalDate(input.hasta, 1), '00:00', timeZone);

    // Con turno_id el servicio y la profesional salen del turno: nunca de lo que escribió el modelo.
    let appointment: CustomerAppointment | undefined;
    if (input.turno_id !== undefined) {
      const loaded = await loadAppointmentToMove(ctx, input);
      if ('failure' in loaded) return loaded.failure;
      appointment = loaded.appointment;
    }
    const serviceId = appointment?.serviceId ?? input.servicio_id;
    const professionalId = appointment?.professionalId ?? input.profesional_id;
    if (!serviceId) {
      return {
        content: { motivo: 'servicio_no_encontrado', mensaje: 'Falta el servicio: buscalo con buscar_servicios' },
        options: [],
        isError: true,
      };
    }

    const loadContext = (window: { start: Date; end: Date }) =>
      appointment
        ? loadRescheduleContext(db, { tenantId, appointment, window, now })
        : loadAvailabilityContext(db, { tenantId, serviceId, window, now });

    const context = await loadContext({ start: rangeStart, end: rangeEnd });
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
    // Un turno que ya existe se puede mover aunque el servicio haya dejado de ofrecerse después.
    if (!appointment && !service.visible) {
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
    if (!appointment && service.requiresConsultation) {
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
    const nameOf = (id: string) => names.get(id) ?? '';

    const requested = professionalId ? team.find((professional) => professional.id === professionalId) : undefined;
    if (professionalId && !requested) {
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

    const [customer] = professionalId
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
      excludeStart: appointment?.start,
    };

    // Cuántas opciones: las del negocio, más "ver otros", sin pasar las 10 filas de una lista.
    const { chosen, hasMore } = pickSpreadSlots(candidateSlots(query, filters), {
      count: Math.min(settings.slotsOffered, MAX_LIST_ROWS - 1),
      minGapMinutes: MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES,
    });

    const entryOf = (slot: Slot) =>
      slotOffer(
        {
          serviceId: service.id,
          professionalId: slot.professionalId,
          professionalName: nameOf(slot.professionalId),
          start: slot.start,
          durationMinutes: (slot.end.getTime() - slot.start.getTime()) / MINUTE_MS,
          ...(appointment ? { rescheduleAppointmentId: appointment.id } : {}),
        },
        timeZone,
      );

    const entries = chosen.map(entryOf);

    // Un feriado en que el negocio no trabaja y que ningún horario especial abre.
    const closedDays = settings.worksOnHolidays
      ? []
      : (await listHolidays(db, input.desde, input.hasta)).filter(
          (holiday) => !opensWithSpecialHours(holiday.date, query, requested?.id, timeZone),
        );

    const content: Record<string, unknown> = {
      servicio: serviceRef,
      ...(appointment
        ? { turno: { turnoId: choiceIds.appointment(appointment.id), actual: formatLocalSlot(appointment.start, timeZone) } }
        : {}),
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
        // Al reprogramar, "Ver otros horarios" lleva el turno: sigue en modo reprogramación.
        const moreId = appointment
          ? choiceIds.moreReschedule(appointment.id, last.start)
          : choiceIds.more(service.id, requested?.id ?? null, last.start);
        const more = { id: moreId, title: SEE_MORE_TITLE };
        options.push(more);
        // El modelo solo lee el contenido: sin este id no puede ofrecer el botón.
        content.verMas = { opcionId: more.id, texto: more.title };
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
      const later = await loadContext({ start: rangeEnd, end: horizonEnd });
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
