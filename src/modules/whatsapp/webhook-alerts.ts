import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { raiseAlert } from '../../shared/alerts.js';
import type { Queryable } from '../../shared/db.js';
import { tenants } from '../tenants/schema.js';
import type { AccountChange } from './webhook-payload.js';

/**
 * Alertas que salen del webhook de WhatsApp en el momento, sin pasar por el worker (6.5, decisión 59):
 * no guardan ni contestan nada, así que una tarea solo sumaría una fila y una vuelta.
 */

/** Eventos de `account_update` que dejan al negocio sin recibir o enviar mensajes (10.3). */
export const ALERTED_ACCOUNT_EVENTS: readonly string[] = [
  'PARTNER_REMOVED',
  'PARTNER_APP_UNINSTALLED',
  'ACCOUNT_OFFBOARDED',
  'DISABLED_UPDATE',
  'ACCOUNT_RESTRICTION',
  'ACCOUNT_VIOLATION',
  'ACCOUNT_DELETED',
];

/** Estados de una plantilla con los que deja de salir (8.1). */
export const ALERTED_TEMPLATE_EVENTS: readonly string[] = ['REJECTED', 'PAUSED', 'DISABLED', 'FLAGGED'];

function isAlerted(change: AccountChange): boolean {
  return change.kind === 'account_update'
    ? ALERTED_ACCOUNT_EVENTS.includes(change.event)
    : ALERTED_TEMPLATE_EVENTS.includes(change.event);
}

export async function alertAccountChanges(
  deps: { db: Queryable; logger: Logger },
  changes: readonly AccountChange[],
): Promise<void> {
  const tenantByAccount = new Map<string, string | null>();
  const findTenant = async (wabaId: string) => {
    if (!tenantByAccount.has(wabaId)) {
      const [tenant] = await deps.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.whatsappBusinessAccountId, wabaId));
      tenantByAccount.set(wabaId, tenant?.id ?? null);
    }
    return tenantByAccount.get(wabaId) ?? null;
  };

  for (const change of changes) {
    if (!isAlerted(change)) continue;
    // Una cuenta que no es de ningún negocio (la del número de avisos, 8.2) alerta igual, con su id.
    const tenantId = await findTenant(change.wabaId);
    if (change.kind === 'account_update') {
      raiseAlert(deps.logger, { kind: 'account_update', tenantId, detail: change.event, ids: { wabaId: change.wabaId } });
    } else {
      raiseAlert(deps.logger, {
        kind: 'template_status',
        tenantId,
        detail: `${change.templateName}:${change.event}`,
        ids: { wabaId: change.wabaId, templateId: change.templateId, language: change.language, reason: change.reason },
      });
    }
  }
}

export interface FailedDelivery {
  tenantId: string;
  messageId: string;
  errors: { code: number; title: string }[];
}

/** Meta informó un envío con estado `failed` (6.5): la alerta se agrupa por negocio y código de error. */
export function alertFailedDeliveries(logger: Logger, failures: readonly FailedDelivery[]): void {
  for (const failure of failures) {
    const [error] = failure.errors;
    raiseAlert(logger, {
      kind: 'delivery_failed',
      tenantId: failure.tenantId,
      detail: error ? String(error.code) : 'sin-codigo',
      ids: { messageId: failure.messageId },
    });
  }
}
