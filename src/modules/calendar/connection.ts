import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { professionals } from '../catalog/schema.js';
import { scheduleJob } from '../jobs/queue.js';
import { tenants } from '../tenants/schema.js';
import { eventIdFor } from './appointment-event.js';
import type { CalendarDependencies } from './appointment-sync.js';
import { GoogleApiError } from './google-auth.js';

export type ConnectionResult =
  | { status: 'connected' }
  | { status: 'tenant_not_found' }
  | { status: 'professional_not_found' }
  /** Google no lo encuentra: no se lo compartieron a la cuenta de servicio, o el id está mal. */
  | { status: 'not_shared' }
  /** Lo puede leer pero no escribir: lo compartieron sin "Hacer cambios en eventos". */
  | { status: 'read_only' };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Conecta el calendario de una profesional (8.4, D11). Antes de guardarlo verifica con Google que
 * la cuenta de servicio puede leerlo y escribir en él: escribe un evento de ayer (en el pasado no
 * dispara recordatorios) y lo borra en el momento. Después programa la primera copia de bloqueos,
 * en la misma transacción que guarda el calendario.
 */
export async function connectProfessionalCalendar(
  deps: CalendarDependencies,
  input: { tenantSlug: string; professionalName: string; calendarId: string },
): Promise<ConnectionResult> {
  const { db, client } = deps;
  const now = deps.now();

  const [tenant] = await db
    .select({ id: tenants.id, timeZone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.slug, input.tenantSlug));
  if (!tenant) return { status: 'tenant_not_found' };
  const [professional] = await db
    .select({ id: professionals.id })
    .from(professionals)
    .where(and(eq(professionals.tenantId, tenant.id), sql`lower(${professionals.name}) = lower(${input.professionalName})`));
  if (!professional) return { status: 'professional_not_found' };

  try {
    await client.listEvents(input.calendarId, { start: now, end: new Date(now.getTime() + DAY_MS) });
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) return { status: 'not_shared' };
    throw error;
  }

  const probeId = randomUUID();
  const probeStart = new Date(now.getTime() - DAY_MS);
  try {
    await client.saveEvent(input.calendarId, {
      id: eventIdFor(probeId),
      appointmentId: probeId,
      summary: 'Prueba de conexión del asistente (se borra sola)',
      description: 'La cuenta de servicio verificó que puede escribir en este calendario.',
      start: probeStart,
      end: new Date(probeStart.getTime() + HOUR_MS),
      timeZone: tenant.timeZone,
      tentative: false,
    });
  } catch (error) {
    if (error instanceof GoogleApiError && (error.status === 403 || error.status === 404)) return { status: 'read_only' };
    throw error;
  }
  await client.deleteEvent(input.calendarId, eventIdFor(probeId));

  await db.transaction(async (tx) => {
    await tx
      .update(professionals)
      .set({ googleCalendarId: input.calendarId })
      .where(and(eq(professionals.tenantId, tenant.id), eq(professionals.id, professional.id)));
    await scheduleJob(tx, {
      tenantId: tenant.id,
      kind: 'sync_calendar_blocks',
      key: professional.id,
      payload: { professionalId: professional.id },
      runAt: now,
    });
  });
  return { status: 'connected' };
}
