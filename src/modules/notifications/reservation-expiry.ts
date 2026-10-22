import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { JobHandler } from '../jobs/runner.js';
import { expirePayloadSchema } from '../scheduling/appointment-jobs.js';
import { expireReservation } from '../scheduling/booking.js';
import { loadNoticeAppointment } from './notice-data.js';
import { enqueueNotification } from './outbox.js';
import { notifications } from './schema.js';
import { reservationExpired, reservationExpiredTemplate } from './texts.js';

/**
 * El vencimiento de la reserva provisoria (4.5, H10). Lo decide `booking.ts` con el turno bloqueado:
 * solo vence uno pendiente de seña con el plazo pasado, nunca uno en verificación. En la misma
 * transacción queda el aviso a la clienta, que ofrece otro horario. Si el turno ya estaba vencido (lo
 * venció una reserva que pisaba su horario) también avisa: el aviso sale una vez, venza por donde venza.
 */

export interface ExpiryDependencies {
  db: NodePgDatabase;
  logger: Logger;
  now: () => Date;
}

export type ExpiryJobResult = 'expired' | 'already_expired' | 'not_due' | 'not_pending' | 'not_found';

export async function runReservationExpiry(
  deps: ExpiryDependencies,
  input: { tenantId: string; appointmentId: string },
): Promise<ExpiryJobResult> {
  const { db } = deps;
  const { tenantId, appointmentId } = input;
  const now = deps.now();

  const result = await expireReservation(db, {
    tenantId,
    appointmentId,
    now,
    inTransaction: async (tx, { start }) => {
      const [already] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            eq(notifications.appointmentId, appointmentId),
            eq(notifications.kind, 'reservation_expired'),
            eq(notifications.appointmentStart, start),
          ),
        );
      if (already) return;

      const appointment = await loadNoticeAppointment(tx, { tenantId, appointmentId });
      await enqueueNotification(tx, {
        tenantId,
        recipient: 'customer',
        kind: 'reservation_expired',
        customerId: appointment.customerId,
        appointmentId,
        appointmentStart: start,
        message: reservationExpired(appointment),
        template: reservationExpiredTemplate(appointment),
        now,
      });
    },
  });
  return result.ok ? result.outcome : result.reason;
}

/** El handler de las tareas `expire_reservation` para el worker. */
export function reservationExpiryJobHandler(deps: ExpiryDependencies): JobHandler {
  return async (job, { signal }) => {
    const payload = expirePayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new Error(`Datos de la tarea inválidos: ${z.prettifyError(payload.error)}`);
    }
    signal.throwIfAborted();
    const result = await runReservationExpiry(deps, { tenantId: job.tenantId, appointmentId: payload.data.appointmentId });
    deps.logger.info({ tenant_id: job.tenantId, appointment_id: payload.data.appointmentId, result }, 'Vencimiento de reserva');
  };
}
