import { and, asc, count, countDistinct, eq, gte, lte, max, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { raiseAlert } from '../../shared/alerts.js';
import type { Queryable } from '../../shared/db.js';
import { instantToLocal } from '../../shared/time-zone.js';
import { holidays } from '../catalog/schema.js';
import { loadHumanAttention } from '../conversation/handoff.js';
import { handoffs, messages } from '../conversation/schema.js';
import { scheduleJob, scheduleJobs } from '../jobs/queue.js';
import type { JobHandler } from '../jobs/runner.js';
import { tenants } from '../tenants/schema.js';
import { evaluateAlertChecks, type AlertCheckInput } from './checks.js';

/**
 * La tarea "revisar alertas" (10.3): una por negocio, con su id como clave. Al empezar programa la
 * próxima vuelta, como la copia de bloqueos (6.7), así que nunca queda fallida.
 */

/** [S] Cada cuánto se revisa cada negocio. */
export const ALERT_CHECK_INTERVAL_MS = 15 * 60_000;

const WEEK_MS = 7 * 86_400_000;

export interface AlertCheckDependencies {
  db: Queryable;
  logger: Logger;
  now: () => Date;
}

/** Lo que la revisión necesita saber del negocio, leído de la base. Null: el negocio no está activo. */
async function loadAlertCheckInput(db: Queryable, tenantId: string, now: Date): Promise<AlertCheckInput | null> {
  const [tenant] = await db
    .select({ status: tenants.status, timeZone: tenants.timezone, coexistenceSince: tenants.whatsappCoexistenceSince })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (tenant?.status !== 'active') return null;

  const weekStart = new Date(now.getTime() - WEEK_MS);
  const nextYear = Number(instantToLocal(now, tenant.timeZone).date.slice(0, 4)) + 1;

  const [lastEcho] = await db
    .select({ at: max(messages.createdAt) })
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.direction, 'echo')));
  const open = and(eq(handoffs.tenantId, tenantId), eq(handoffs.status, 'open'));
  const [oldestOpenHandoff] = await db
    .select({ id: handoffs.id, createdAt: handoffs.createdAt })
    .from(handoffs)
    .where(open)
    .orderBy(asc(handoffs.createdAt))
    .limit(1);
  const [openHandoffs] = await db.select({ total: count() }).from(handoffs).where(open);
  const [weeklyHandoffs] = await db
    .select({ total: count() })
    .from(handoffs)
    .where(and(eq(handoffs.tenantId, tenantId), gte(handoffs.createdAt, weekStart), lte(handoffs.createdAt, now)));
  const [weeklyConversations] = await db
    .select({ total: countDistinct(messages.conversationId) })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.direction, 'inbound'),
        gte(messages.occurredAt, weekStart),
        lte(messages.occurredAt, now),
      ),
    );
  // Los feriados son del país (tabla global): no se filtran por negocio.
  const [nextYearHolidays] = await db
    .select({ total: count() })
    .from(holidays)
    .where(sql`${holidays.date} between ${`${String(nextYear)}-01-01`} and ${`${String(nextYear)}-12-31`}`);

  const { attention } = await loadHumanAttention(db, { tenantId, now });
  return {
    tenantId,
    now,
    timeZone: tenant.timeZone,
    coexistenceSince: tenant.coexistenceSince,
    lastEchoAt: lastEcho?.at ?? null,
    oldestOpenHandoff: oldestOpenHandoff ?? null,
    openHandoffs: openHandoffs?.total ?? 0,
    attendingNow: attention.kind === 'now',
    nextYearHolidays: nextYearHolidays?.total ?? 0,
    weeklyHandoffs: weeklyHandoffs?.total ?? 0,
    weeklyConversations: weeklyConversations?.total ?? 0,
  };
}

export function alertChecksJobHandler(deps: AlertCheckDependencies): JobHandler {
  return async (job) => {
    const now = deps.now();
    // Regla 7: un negocio pausado o dado de baja no se revisa, y su tarea no vuelve.
    const input = await loadAlertCheckInput(deps.db, job.tenantId, now);
    if (!input) return;

    await scheduleJob(deps.db, {
      tenantId: job.tenantId,
      kind: 'check_alerts',
      key: job.tenantId,
      runAt: new Date(now.getTime() + ALERT_CHECK_INTERVAL_MS),
    });
    for (const alert of evaluateAlertChecks(input)) raiseAlert(deps.logger, alert);
  };
}

/**
 * Al arrancar el servidor, la revisión de cada negocio activo queda programada para ahora: así un
 * negocio nuevo entra con el próximo reinicio. Es idempotente (una fila por negocio, 6.7).
 */
export async function scheduleAlertChecks(db: Queryable, now: Date): Promise<number> {
  const active = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
  await scheduleJobs(
    db,
    active.map((tenant) => ({ tenantId: tenant.id, kind: 'check_alerts' as const, key: tenant.id, runAt: now })),
  );
  return active.length;
}
