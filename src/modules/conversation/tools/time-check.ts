import { listHolidays } from '../../catalog/queries.js';
import {
  alignToClock,
  diagnoseStart,
  nearestGridStart,
  pickFirstAvailable,
  type Slot,
  type SlotVerdict,
} from '../../scheduling/availability.js';
import type { CustomerAppointment } from '../../scheduling/customer-appointments.js';
import {
  MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES,
  pickNearestSlots,
} from '../../scheduling/slot-selection.js';
import type { TimestampRange } from '../../../shared/timestamp-range.js';
import { addDaysToLocalDate, instantToLocal, localDateTimeToInstant } from '../../../shared/time-zone.js';
import { formatClockTime, formatLocalDate, formatLocalSlot } from '../format.js';
import { candidateSlots, findNextSlot, prepareSearch, type PreparedSearch } from './availability-search.js';
import { MAX_LIST_ROWS, type OfferableOption, type ToolContext, type ToolResult } from './tool.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Lo que piden las dos herramientas de una hora puntual (`consultar_hora` y
 * `consultar_hora_para_reprogramar`, 6.4, decisión 29), ya con el servicio y la profesional resueltos.
 * La fecha y la hora son locales del negocio: el código las pasa a un instante.
 */
export interface TimeCheckRequest {
  serviceId: string;
  /** Solo si se pidió una profesional puntual (al reprogramar, la del turno). */
  professionalId: string | undefined;
  /** Al reprogramar: el turno que se mueve. Las medidas y la profesional son las suyas y él no cuenta como ocupado. */
  appointment: CustomerAppointment | undefined;
  /** AAAA-MM-DD */
  fecha: string;
  /** HH:MM */
  hora: string;
}

type Refusal = Exclude<SlotVerdict['kind'], 'free'>;

/** El motivo, como lo lee el modelo. */
const REASON: Record<Refusal, string> = {
  taken: 'ocupado',
  too_soon: 'sin_anticipacion_minima',
  too_far: 'mas_alla_de_la_anticipacion_maxima',
  holiday: 'feriado',
  closed_day: 'dia_cerrado',
  outside_hours: 'fuera_de_horario',
  off_grid: 'fuera_de_la_grilla',
};

/**
 * Si ninguna profesional puede, el motivo que se informa es el de la que estuvo más cerca de poder: una
 * ocupada (el horario era válido) pesa más que una a la que solo le falta estar en la grilla, y esta más que
 * una fuera de horario o que no trabaja ese día. La anticipación y el feriado son iguales para todas.
 */
const REASON_PRIORITY: Refusal[] = ['taken', 'off_grid', 'outside_hours', 'closed_day', 'too_soon', 'too_far', 'holiday'];

interface Explanation {
  motivo: string;
  mensaje: string;
  extra: Record<string, unknown>;
}

/** El motivo escrito por el código: la clienta lee esto a través del modelo, que no lo inventa. */
async function explain(kind: Refusal, prepared: PreparedSearch, ctx: ToolContext, start: Date, fecha: string): Promise<Explanation> {
  const { db, now, timeZone } = ctx;
  const { rules } = prepared.query;
  const motivo = REASON[kind];

  switch (kind) {
    case 'taken':
      return { motivo, mensaje: 'Ese horario ya está ocupado: hay otro turno a esa hora.', extra: {} };
    case 'outside_hours':
      return {
        motivo,
        mensaje:
          'Esa hora queda fuera del horario de atención: el turno tiene que entrar completo dentro del horario de trabajo.',
        extra: {},
      };
    case 'closed_day':
      return { motivo, mensaje: 'Ese día no hay atención.', extra: {} };
    case 'holiday': {
      const holiday = (await listHolidays(db, fecha, fecha))[0];
      return {
        motivo,
        mensaje: `Ese día es feriado${holiday ? ` (${holiday.name})` : ''} y el negocio no atiende.`,
        extra: holiday ? { feriado: holiday.name } : {},
      };
    }
    case 'off_grid': {
      const nearest = formatClockTime(
        instantToLocal(nearestGridStart(start, rules.slotGranularityMinutes, timeZone), timeZone).time,
      );
      return {
        motivo,
        mensaje:
          `Los turnos empiezan cada ${String(rules.slotGranularityMinutes)} minutos: esa hora no es un inicio válido. ` +
          `La hora válida más cercana es ${nearest}.`,
        extra: { horaValidaMasCercana: nearest },
      };
    }
    case 'too_soon': {
      const earliest = formatLocalSlot(
        new Date(alignToClock(now.getTime() + rules.minBookingNoticeMinutes * MINUTE_MS, rules.slotGranularityMinutes, timeZone)),
        timeZone,
      );
      return {
        motivo,
        mensaje:
          start.getTime() <= now.getTime()
            ? 'Ese horario ya pasó.'
            : `Hace falta reservar con más anticipación: lo más pronto es ${earliest}.`,
        extra: { reservableDesde: earliest },
      };
    }
    case 'too_far': {
      const latest = formatLocalDate(
        instantToLocal(new Date(now.getTime() + rules.maxBookingAdvanceDays * DAY_MS), timeZone).date,
      );
      return {
        motivo,
        mensaje: `Todavía no se puede reservar tan adelante: se reserva hasta el ${latest}.`,
        extra: { reservableHasta: latest },
      };
    }
  }
}

/**
 * Los horarios libres más cercanos a la hora pedida ese día, con las opciones de siempre (4.3). Si ese día no
 * queda ninguno, el próximo horario libre.
 */
async function alternatives(
  prepared: PreparedSearch,
  ctx: ToolContext,
  start: Date,
  dayEnd: Date,
): Promise<{ content: Record<string, unknown>; options: OfferableOption[] }> {
  const nearest = pickNearestSlots(candidateSlots(prepared.query, prepared.filters), {
    target: start,
    count: Math.min(prepared.settings.slotsOffered, MAX_LIST_ROWS),
    minGapMinutes: MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES,
  });
  const entries = nearest.map(prepared.entryOf);
  const content: Record<string, unknown> = { horariosCercanos: entries.map((entry) => entry.content) };
  const options = entries.map((entry) => entry.option);

  if (entries.length === 0) {
    const next = await findNextSlot(prepared, dayEnd, ctx);
    if (next) {
      const entry = prepared.entryOf(next);
      content.proximoHorario = entry.content;
      options.push(entry.option);
    }
  }
  return { content, options };
}

/**
 * Si una hora puntual está libre para reservar o para mover un turno (6.4, decisión 29). La valida con
 * la misma lógica que la reserva (grilla, horario, bloques, anticipación, feriados, excepciones y
 * ocupación). Si está libre, la ofrece como opción; si no, dice el motivo real y ofrece los horarios libres
 * más cercanos. El modelo nunca convierte horarios ni decide si está libre.
 */
export async function checkTime(request: TimeCheckRequest, ctx: ToolContext): Promise<ToolResult> {
  ctx.signal.throwIfAborted();
  const { timeZone } = ctx;
  const { appointment } = request;

  const start = localDateTimeToInstant(request.fecha, request.hora, timeZone);
  const day: TimestampRange = {
    start: localDateTimeToInstant(request.fecha, '00:00', timeZone),
    end: localDateTimeToInstant(addDaysToLocalDate(request.fecha, 1), '00:00', timeZone),
  };

  const preparation = await prepareSearch(
    { ...request, franja: undefined, despuesDe: undefined },
    ctx,
    day,
  );
  if ('early' in preparation) {
    // Un servicio que no se agenda por acá: no hay horarios, y se dice que no está libre.
    const { early } = preparation;
    return early.isError ? early : { ...early, content: { ...early.content, libre: false } };
  }
  const { prepared } = preparation;
  const refused = async (explanation: Explanation, extra: Record<string, unknown> = {}): Promise<ToolResult> => {
    const near = await alternatives(prepared, ctx, start, day.end);
    return {
      content: {
        ...prepared.header,
        libre: false,
        consultada: formatLocalSlot(start, timeZone),
        motivo: explanation.motivo,
        mensaje: explanation.mensaje,
        ...explanation.extra,
        ...extra,
        ...near.content,
      },
      options: near.options,
    };
  };

  // Mover un turno a la hora en que ya está no cambia nada.
  if (appointment?.start.getTime() === start.getTime()) {
    return refused({
      motivo: 'misma_hora_del_turno',
      mensaje: 'Ese ya es el horario del turno: no hay nada que mover. Si quiere cambiarlo, ofrecele otro.',
      extra: {},
    });
  }

  const team = prepared.requested ? [prepared.requested] : prepared.query.professionals;
  if (team.length === 0) {
    return refused({
      motivo: 'servicio_no_disponible',
      mensaje: 'Este servicio no se agenda por este medio: ofrecé que lo vea una persona',
      extra: {},
    });
  }

  const verdicts = team.map((professional) => ({
    professional,
    verdict: diagnoseStart(prepared.query, professional, start),
  }));

  const freeSlots: Slot[] = verdicts.flatMap(({ verdict }) => (verdict.kind === 'free' ? [verdict.slot] : []));
  const [chosen] = pickFirstAvailable(freeSlots, {
    professionalOrder: prepared.query.professionals.map((professional) => professional.id),
    preferredProfessionalId: prepared.filters.preferredProfessionalId,
  });
  if (chosen) {
    const entry = prepared.entryOf(chosen);
    return { content: { ...prepared.header, libre: true, horario: entry.content }, options: [entry.option] };
  }

  const refusals = verdicts.flatMap(({ professional, verdict }) =>
    verdict.kind === 'free' ? [] : [{ professional, kind: verdict.kind }],
  );
  const top = REASON_PRIORITY.find((kind) => refusals.some((refusal) => refusal.kind === kind)) ?? 'outside_hours';
  // Con varias profesionales que no coinciden, cada una con su motivo: el modelo no generaliza el de una a todas.
  const differ = refusals.some((refusal) => refusal.kind !== top);
  return refused(
    await explain(top, prepared, ctx, start, request.fecha),
    differ
      ? {
          profesionales: refusals.map((refusal) => ({
            profesional: prepared.nameOf(refusal.professional.id),
            motivo: REASON[refusal.kind],
          })),
        }
      : {},
  );
}
