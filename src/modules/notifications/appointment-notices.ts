import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../../shared/db.js';
import { deposits } from '../payments/schema.js';
import { loadNoticeAppointment } from './notice-data.js';
import { enqueueNotification } from './outbox.js';
import { cancellationNotice, cancellationTemplate, rescheduleNotice, rescheduleTemplate } from './texts.js';

/**
 * El aviso a la dueña cuando el asistente cancela o reprograma un turno (4.6). Va dentro de la
 * transacción del cambio (el callback de `booking.ts`): si el cambio no queda, el aviso tampoco.
 */
export async function enqueueAppointmentChangeNotice(
  tx: Queryable,
  input: {
    tenantId: string;
    appointmentId: string;
    change: { kind: 'cancelled' } | { kind: 'rescheduled'; previousStart: Date };
    now: Date;
  },
): Promise<void> {
  const { tenantId, appointmentId, change, now } = input;
  const appointment = await loadNoticeAppointment(tx, { tenantId, appointmentId });

  let message;
  let template;
  if (change.kind === 'cancelled') {
    const [deposit] = await tx
      .select({ status: deposits.status, amountCents: deposits.amountCents })
      .from(deposits)
      .where(and(eq(deposits.tenantId, tenantId), eq(deposits.appointmentId, appointmentId)));
    message = cancellationNotice({ appointment, deposit: deposit ?? null });
    template = cancellationTemplate({ appointment, deposit: deposit ?? null });
  } else {
    message = rescheduleNotice({ appointment, previousStart: change.previousStart });
    template = rescheduleTemplate({ appointment, previousStart: change.previousStart });
  }

  await enqueueNotification(tx, {
    tenantId,
    recipient: 'owner',
    kind: change.kind === 'cancelled' ? 'appointment_cancelled' : 'appointment_rescheduled',
    customerId: appointment.customerId,
    appointmentId,
    message,
    template,
    now,
  });
}
