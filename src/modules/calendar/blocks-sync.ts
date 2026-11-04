import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { professionals } from '../catalog/schema.js';
import { scheduleJob } from '../jobs/queue.js';
import type { JobHandler } from '../jobs/runner.js';
import { scheduledJobs } from '../jobs/schema.js';
import { overlaps } from '../scheduling/availability-context.js';
import { replaceCalendarBlocks } from '../scheduling/calendar-sync.js';
import { appointments } from '../scheduling/schema.js';
import { tenants, tenantSettings } from '../tenants/schema.js';
import type { CalendarDependencies } from './appointment-sync.js';
import { busyBlocks } from './busy-blocks.js';
import type { CalendarEvent } from './client.js';

/** [S] Cada cuánto se copian los bloqueos de una profesional (6.7, D4). */
export const CALENDAR_SYNC_INTERVAL_MS = 2 * 60_000;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const blocksSyncPayloadSchema = z.object({ professionalId: z.uuid() });

export type BlocksSyncResult = 'synced' | 'no_calendar';

/**
 * Copia los eventos ocupados del calendario de la profesional a `calendar_blocks` (D4). Antes de
 * leer se programa la próxima vuelta: si Google falla, la sincronización sigue y la disponibilidad
 * usa los últimos bloqueos copiados. De paso avisa si alguien movió o borró a mano el evento de un
 * turno (D10): no lo restaura.
 */
export async function syncCalendarBlocks(
  deps: CalendarDependencies,
  input: { tenantId: string; professionalId: string },
): Promise<BlocksSyncResult> {
  const { db, client, logger } = deps;
  const { tenantId, professionalId } = input;
  const now = deps.now();

  const [row] = await db
    .select({
      calendarId: professionals.googleCalendarId,
      timeZone: tenants.timezone,
      maxAdvanceDays: tenantSettings.maxBookingAdvanceDays,
    })
    .from(professionals)
    .innerJoin(tenants, eq(tenants.id, professionals.tenantId))
    .innerJoin(tenantSettings, eq(tenantSettings.tenantId, professionals.tenantId))
    .where(and(eq(professionals.tenantId, tenantId), eq(professionals.id, professionalId), eq(professionals.active, true)));
  if (!row?.calendarId) return 'no_calendar';

  await scheduleJob(db, {
    tenantId,
    kind: 'sync_calendar_blocks',
    key: professionalId,
    payload: { professionalId },
    runAt: new Date(now.getTime() + CALENDAR_SYNC_INTERVAL_MS),
  });

  // Un día más que la anticipación máxima: un turno que empieza en el último día puede cruzarla.
  const window = { start: now, end: new Date(now.getTime() + (row.maxAdvanceDays + 1) * DAY_MS) };
  const events = await client.listEvents(row.calendarId, window);
  const blocks = busyBlocks(events, row.timeZone);
  await db.transaction((tx) => replaceCalendarBlocks(tx, { tenantId, professionalId, blocks }));

  for (const edit of await manualEdits(deps, { tenantId, professionalId, window, events })) {
    logger.warn({ tenantId, ...edit }, 'Evento de un turno editado a mano en Google Calendar');
  }
  return 'synced';
}

/**
 * Los turnos con evento escrito cuyo evento ya no coincide: se movió o se borró a mano. Un turno
 * con su tarea de calendario pendiente no cuenta: el evento todavía no se actualizó.
 */
async function manualEdits(
  deps: CalendarDependencies,
  input: { tenantId: string; professionalId: string; window: { start: Date; end: Date }; events: CalendarEvent[] },
): Promise<{ appointmentId: string; problem: 'moved' | 'deleted' }[]> {
  const { db } = deps;
  const { tenantId } = input;
  const written = await db
    .select({ id: appointments.id, timeRange: appointments.timeRange, durationMinutes: appointments.durationMinutes })
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        eq(appointments.professionalId, input.professionalId),
        isNotNull(appointments.calendarEventId),
        inArray(appointments.status, ['CONFIRMED', 'DEPOSIT_REVIEW']),
        overlaps(appointments.timeRange, input.window),
      ),
    );
  if (written.length === 0) return [];

  const pending = await db
    .select({ key: scheduledJobs.key })
    .from(scheduledJobs)
    .where(
      and(
        eq(scheduledJobs.tenantId, tenantId),
        eq(scheduledJobs.kind, 'sync_appointment_event'),
        inArray(scheduledJobs.status, ['pending', 'running']),
        inArray(scheduledJobs.key, written.map((appointment) => appointment.id)),
      ),
    );
  const waiting = new Set(pending.map((job) => job.key));

  const edits: { appointmentId: string; problem: 'moved' | 'deleted' }[] = [];
  for (const appointment of written) {
    if (waiting.has(appointment.id)) continue;
    const event = input.events.find((candidate) => candidate.appointmentId === appointment.id && !candidate.cancelled);
    if (!event) {
      edits.push({ appointmentId: appointment.id, problem: 'deleted' });
      continue;
    }
    const start = appointment.timeRange.start.getTime();
    const end = start + appointment.durationMinutes * MINUTE_MS;
    const matches = 'at' in event.start && 'at' in event.end && event.start.at.getTime() === start && event.end.at.getTime() === end;
    if (!matches) edits.push({ appointmentId: appointment.id, problem: 'moved' });
  }
  return edits;
}

export function calendarBlocksJobHandler(deps: CalendarDependencies): JobHandler {
  return async (job) => {
    const { professionalId } = blocksSyncPayloadSchema.parse(job.payload);
    await syncCalendarBlocks(deps, { tenantId: job.tenantId, professionalId });
  };
}
