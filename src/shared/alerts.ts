import * as Sentry from '@sentry/node';
import type { Logger } from 'pino';

/**
 * Alertas a Yordi (10.3): cada una es un log de nivel `error` y un evento de Sentry con una huella
 * fija. Sentry junta los eventos con la misma huella en un issue y avisa por email cuando aparece uno
 * nuevo o vuelve uno resuelto (decisión 53). Sin `SENTRY_DSN` (desarrollo, tests) queda solo el log.
 */
export const ALERT_TITLES = {
  delivery_failed: 'Envío fallido a WhatsApp',
  job_failed: 'Tarea programada fallida',
  credential_rejected: 'Credencial rechazada',
  template_status: 'Plantilla rechazada o pausada por Meta',
  account_update: 'Número desconectado o restringido por Meta',
  calendar_event_edited: 'Evento de un turno editado a mano en Google Calendar',
  echoes_missing: 'Sin ecos de la app de la dueña hace más de 10 días',
  handoff_waiting: 'Derivación sin resolver hace más de 4 horas',
  holidays_missing: 'Feriados del año siguiente sin cargar',
  handoff_rate: 'Tasa de derivaciones mayor al 30 % en la semana',
  test: 'Alerta de prueba',
} as const;

export type AlertKind = keyof typeof ALERT_TITLES;

export interface Alert {
  kind: AlertKind;
  /** Null: no es de un negocio (por ejemplo, una cuenta de Meta que no es de ninguno). */
  tenantId: string | null;
  /** Lo que la distingue dentro de su tipo (el proveedor, el tipo de tarea, el código de error). Va en la huella. */
  detail?: string;
  /** Solo ids y códigos: nunca teléfonos, nombres ni textos de mensajes. */
  ids?: Record<string, string | number | null>;
}

/** Los eventos con la misma huella son el mismo issue: un problema que se repite avisa una sola vez. */
export function alertFingerprint(alert: Alert): string[] {
  return [alert.kind, alert.tenantId ?? 'sin-negocio', ...(alert.detail === undefined ? [] : [alert.detail])];
}

export function raiseAlert(logger: Logger, alert: Alert): void {
  const { kind, tenantId, detail, ids = {} } = alert;
  const message = detail === undefined ? ALERT_TITLES[kind] : `${ALERT_TITLES[kind]}: ${detail}`;

  logger.error({ ...ids, alert: kind, tenantId, detail }, message);
  Sentry.captureMessage(message, {
    level: 'error',
    fingerprint: alertFingerprint(alert),
    tags: { alert: kind, ...(tenantId ? { tenant_id: tenantId } : {}) },
    extra: ids,
  });
}
