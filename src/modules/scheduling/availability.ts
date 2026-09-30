import type { TimestampRange } from '../../shared/timestamp-range.js';
import {
  addDaysToLocalDate,
  instantToLocal,
  isoWeekday,
  localDateTimeToInstant,
  type LocalDate,
  type LocalTime,
} from '../../shared/time-zone.js';
import { occupiesSchedule, type AppointmentStatus } from './appointment-state-machine.js';

/**
 * Cálculo de disponibilidad (sección 4.3). Función pura: no toca la base ni la red,
 * recibe todo lo que necesita y la hora actual (`now`) por parámetro.
 *
 *   horario semanal (o especial) − cierres y feriados → bloques de trabajo
 *   → inicios cada `slotGranularityMinutes`, alineados al reloj local
 *   → la duración entra en el bloque; el margen puede quedar después del cierre
 *   → ni la duración ni el margen pisan turnos ni eventos ocupados del calendario
 *   → filtrado por anticipación mínima y máxima
 */

/** Bloque del horario semanal. `weekday`: 1 = lunes … 7 = domingo. */
export interface WeeklyBlock {
  weekday: number;
  start: LocalTime;
  end: LocalTime;
}

export interface ProfessionalSchedule {
  id: string;
  weeklyHours: WeeklyBlock[];
  /** Si a esta profesional el servicio le lleva otro tiempo (sección 4.1). */
  durationOverrideMinutes?: number | null;
  /** Turnos que ocupan su horario (con su margen) y eventos ocupados de su calendario. */
  busy: TimestampRange[];
}

/**
 * `closed`: el rango no se trabaja. `special_hours`: ese día, el rango reemplaza el horario
 * semanal de la profesional o, si es de todo el negocio, recorta el de todas.
 */
export interface ScheduleException {
  /** Null = todo el negocio. */
  professionalId: string | null;
  kind: 'closed' | 'special_hours';
  range: TimestampRange;
}

export interface AvailabilityRules {
  slotGranularityMinutes: number;
  minBookingNoticeMinutes: number;
  maxBookingAdvanceDays: number;
}

export interface AvailabilityQuery {
  now: Date;
  timeZone: string;
  /** Dónde buscar: los turnos empiezan dentro de este rango. */
  window: TimestampRange;
  service: { durationMinutes: number; bufferMinutes: number };
  professionals: ProfessionalSchedule[];
  exceptions: ScheduleException[];
  /** Feriados nacionales, "AAAA-MM-DD". */
  holidays: LocalDate[];
  worksOnHolidays: boolean;
  rules: AvailabilityRules;
}

export interface Slot {
  professionalId: string;
  start: Date;
  /** Fin del turno que ve la clienta. */
  end: Date;
  /** Hasta cuándo ocupa a la profesional: fin más margen. */
  occupiedUntil: Date;
}

interface Interval {
  start: number;
  end: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function findAvailableSlots(query: AvailabilityQuery): Slot[] {
  assertValidQuery(query);
  const { now, window, rules, service, timeZone } = query;

  const earliestStart = Math.max(
    window.start.getTime(),
    now.getTime() + rules.minBookingNoticeMinutes * MINUTE_MS,
  );
  const latestStart = Math.min(
    window.end.getTime() - 1,
    now.getTime() + rules.maxBookingAdvanceDays * DAY_MS,
  );
  if (earliestStart > latestStart) return [];

  const firstDate = instantToLocal(new Date(earliestStart), timeZone).date;
  const lastDate = instantToLocal(new Date(latestStart), timeZone).date;
  const granularityMs = rules.slotGranularityMinutes * MINUTE_MS;

  const slots: Slot[] = [];
  for (const professional of query.professionals) {
    const durationMs = (professional.durationOverrideMinutes ?? service.durationMinutes) * MINUTE_MS;
    const occupiedMs = durationMs + service.bufferMinutes * MINUTE_MS;
    const busy = professional.busy.map(toInterval);

    for (let date = firstDate; date <= lastDate; date = addDaysToLocalDate(date, 1)) {
      for (const block of workingBlocks(professional, date, query)) {
        for (
          let start = alignToClock(block.start, rules.slotGranularityMinutes, timeZone);
          start + durationMs <= block.end;
          start += granularityMs
        ) {
          const fitsWindow = start >= earliestStart && start <= latestStart;
          if (fitsWindow && !overlapsAny({ start, end: start + occupiedMs }, busy)) {
            slots.push({
              professionalId: professional.id,
              start: new Date(start),
              end: new Date(start + durationMs),
              occupiedUntil: new Date(start + occupiedMs),
            });
          }
        }
      }
    }
  }

  // Orden estable: a igual horario, respeta el orden de las profesionales.
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Los bloques en que la profesional trabaja ese día local, ya sin los cierres. */
function workingBlocks(
  professional: ProfessionalSchedule,
  date: LocalDate,
  query: AvailabilityQuery,
): Interval[] {
  const { timeZone, exceptions } = query;
  const day: Interval = {
    start: localDateTimeToInstant(date, '00:00', timeZone).getTime(),
    end: localDateTimeToInstant(addDaysToLocalDate(date, 1), '00:00', timeZone).getTime(),
  };

  const specialHours = (professionalId: string | null) =>
    exceptions
      .filter((e) => e.kind === 'special_hours' && e.professionalId === professionalId)
      .map((e) => intersection(toInterval(e.range), day))
      .filter((interval): interval is Interval => interval !== null);

  const ownSpecial = specialHours(professional.id);
  const businessSpecial = specialHours(null);
  const closedForHoliday = query.holidays.includes(date) && !query.worksOnHolidays;

  let blocks: Interval[];
  if (ownSpecial.length > 0) {
    blocks = ownSpecial;
  } else if (closedForHoliday && businessSpecial.length === 0) {
    blocks = [];
  } else {
    blocks = professional.weeklyHours
      .filter((block) => block.weekday === isoWeekday(date))
      .map((block) => ({
        start: localDateTimeToInstant(date, block.start, timeZone).getTime(),
        end: localDateTimeToInstant(date, block.end, timeZone).getTime(),
      }));
  }

  if (businessSpecial.length > 0) {
    blocks = blocks.flatMap((block) =>
      businessSpecial
        .map((special) => intersection(block, special))
        .filter((interval): interval is Interval => interval !== null),
    );
  }

  const closures = exceptions
    .filter(
      (e) =>
        e.kind === 'closed' && (e.professionalId === null || e.professionalId === professional.id),
    )
    .map((e) => toInterval(e.range));

  return subtract(merge(blocks), closures);
}

/** Primer inicio en la grilla del reloj local (9:00, 9:15…) a partir de `instant`. */
function alignToClock(instant: number, granularityMinutes: number, timeZone: string): number {
  const wholeMinute = Math.ceil(instant / MINUTE_MS) * MINUTE_MS;
  const { minutesOfDay } = instantToLocal(new Date(wholeMinute), timeZone);
  const remainder = minutesOfDay % granularityMinutes;
  return remainder === 0 ? wholeMinute : wholeMinute + (granularityMinutes - remainder) * MINUTE_MS;
}

function toInterval(range: TimestampRange): Interval {
  return { start: range.start.getTime(), end: range.end.getTime() };
}

function intersection(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

function overlapsAny(interval: Interval, others: Interval[]): boolean {
  return others.some((other) => interval.start < other.end && other.start < interval.end);
}

/** Une bloques que se superponen o se tocan: un horario continuo es un solo bloque. */
function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** Saca de cada intervalo las partes que caen en `cuts`; un corte puede partirlo en dos. */
function subtract(intervals: Interval[], cuts: Interval[]): Interval[] {
  return cuts.reduce<Interval[]>(
    (remaining, cut) =>
      remaining.flatMap((interval) => {
        if (cut.end <= interval.start || cut.start >= interval.end) return [interval];
        const pieces: Interval[] = [];
        if (cut.start > interval.start) pieces.push({ start: interval.start, end: cut.start });
        if (cut.end < interval.end) pieces.push({ start: cut.end, end: interval.end });
        return pieces;
      }),
    intervals,
  );
}

function assertValidQuery({ rules, service, window }: AvailabilityQuery): void {
  if (!Number.isInteger(rules.slotGranularityMinutes) || rules.slotGranularityMinutes <= 0) {
    throw new Error(`Granularidad inválida: ${String(rules.slotGranularityMinutes)} minutos`);
  }
  if (rules.minBookingNoticeMinutes < 0 || rules.maxBookingAdvanceDays <= 0) {
    throw new Error('Anticipación mínima o máxima inválida');
  }
  if (service.durationMinutes <= 0 || service.bufferMinutes < 0) {
    throw new Error('Duración o margen del servicio inválidos');
  }
  if (window.end.getTime() <= window.start.getTime()) {
    throw new Error('Ventana de búsqueda inválida: el fin tiene que ser posterior al inicio');
  }
}

/** Turno existente, como lo necesita el cálculo de disponibilidad. */
export interface ExistingAppointment {
  status: AppointmentStatus;
  /** Tiempo ocupado: inicio a fin más margen. */
  timeRange: TimestampRange;
  /** Vencimiento de la seña pendiente, si la hay. */
  depositExpiresAt: Date | null;
}

/**
 * Qué turnos ocupan el horario: confirmados, con la seña en verificación (no vence sola)
 * y con la seña pendiente mientras siga vigente (sección 4.3).
 */
export function occupiedRanges(appointments: ExistingAppointment[], now: Date): TimestampRange[] {
  return appointments
    .filter(
      (appointment) =>
        occupiesSchedule(appointment.status) &&
        !(
          appointment.status === 'PENDING_DEPOSIT' &&
          appointment.depositExpiresAt !== null &&
          appointment.depositExpiresAt.getTime() <= now.getTime()
        ),
    )
    .map((appointment) => appointment.timeRange);
}

/**
 * Si la clienta no eligió profesional, cada horario se ofrece una sola vez, con la primera
 * profesional disponible (sección 4.2): la preferida de la clienta y después el orden dado.
 */
export function pickFirstAvailable(
  slots: Slot[],
  options: { professionalOrder: string[]; preferredProfessionalId?: string | null },
): Slot[] {
  const rank = (professionalId: string) => {
    if (professionalId === options.preferredProfessionalId) return -1;
    const index = options.professionalOrder.indexOf(professionalId);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };

  const byStart = new Map<number, Slot>();
  for (const slot of slots) {
    const key = slot.start.getTime();
    const current = byStart.get(key);
    if (!current || rank(slot.professionalId) < rank(current.professionalId)) {
      byStart.set(key, slot);
    }
  }
  return [...byStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}
