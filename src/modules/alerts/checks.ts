import type { Alert } from '../../shared/alerts.js';
import { instantToLocal, isoWeekday } from '../../shared/time-zone.js';

/**
 * Las revisiones periódicas de las alertas (10.3): qué alertar con lo que la tarea "revisar alertas"
 * leyó de la base. Es pura: la hora actual y los datos llegan por parámetro.
 */

/** [S] Sin ecos por más de esto, la dueña quizás no abrió la app: a los 14 días Meta desconecta el número. */
export const ECHO_SILENCE_MS = 10 * 86_400_000;

/** [S] Una derivación abierta hace más de esto, con el negocio atendiendo, tiene a una clienta esperando. */
export const HANDOFF_WAIT_MS = 4 * 3_600_000;

/** [S] Más derivaciones que esta parte de las conversaciones de la semana: falta información cargada. */
export const HANDOFF_RATE_LIMIT = 0.3;

/** [S] Desde este mes se revisa que estén los feriados del año siguiente. */
const HOLIDAYS_CHECK_MONTH = 12;

const MONDAY = 1;
const DAY_MS = 86_400_000;

export interface AlertCheckInput {
  tenantId: string;
  now: Date;
  /** Zona horaria del negocio: el día y la hora son los suyos. */
  timeZone: string;
  /** Desde cuándo el número está en coexistencia. Null: no lo está, y no hay ecos que esperar. */
  coexistenceSince: Date | null;
  /** Cuándo se guardó el último eco. Null: todavía ninguno. */
  lastEchoAt: Date | null;
  oldestOpenHandoff: { id: string; createdAt: Date } | null;
  openHandoffs: number;
  /** Si ahora atiende una persona del negocio (4.8). */
  attendingNow: boolean;
  /** Feriados cargados del año siguiente al del negocio. */
  nextYearHolidays: number;
  /** Derivaciones de los últimos 7 días. */
  weeklyHandoffs: number;
  /** Conversaciones con mensajes de clientas en los últimos 7 días. */
  weeklyConversations: number;
}

export function evaluateAlertChecks(input: AlertCheckInput): Alert[] {
  const { tenantId, now } = input;
  const alerts: Alert[] = [];

  if (input.coexistenceSince) {
    const since = input.lastEchoAt ?? input.coexistenceSince;
    const silenceMs = now.getTime() - since.getTime();
    if (silenceMs > ECHO_SILENCE_MS) {
      alerts.push({ kind: 'echoes_missing', tenantId, ids: { daysWithoutEchoes: Math.floor(silenceMs / DAY_MS) } });
    }
  }

  const handoff = input.oldestOpenHandoff;
  if (handoff && input.attendingNow && now.getTime() - handoff.createdAt.getTime() > HANDOFF_WAIT_MS) {
    alerts.push({ kind: 'handoff_waiting', tenantId, ids: { handoffId: handoff.id, openHandoffs: input.openHandoffs } });
  }

  const today = instantToLocal(now, input.timeZone).date;
  const [year, month] = today.split('-').map(Number) as [number, number];
  if (month >= HOLIDAYS_CHECK_MONTH && input.nextYearHolidays === 0) {
    // Los feriados son del país, no de un negocio: una sola alerta para todos.
    alerts.push({ kind: 'holidays_missing', tenantId: null, detail: String(year + 1) });
  }

  const { weeklyHandoffs, weeklyConversations } = input;
  if (
    isoWeekday(today) === MONDAY &&
    weeklyConversations > 0 &&
    weeklyHandoffs / weeklyConversations > HANDOFF_RATE_LIMIT
  ) {
    // Una por semana: las revisiones de ese lunes van al mismo issue.
    alerts.push({ kind: 'handoff_rate', tenantId, detail: `semana-${today}`, ids: { weeklyHandoffs, weeklyConversations } });
  }

  return alerts;
}
