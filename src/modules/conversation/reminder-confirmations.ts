import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { confirmAttendance } from '../scheduling/booking.js';
import { inboundContent } from '../whatsapp/webhook-payload.js';
import { parseChoiceId } from './tools/choice-ids.js';

/**
 * El «Confirmo» del recordatorio (4.7, H10). Lo registra el código antes de llamar al modelo, como el
 * comprobante (decisión 37): el toque queda registrado aunque el modelo no llame a nada, y también con
 * el asistente pausado. El turno se vuelve a validar: tiene que ser de esta clienta y seguir confirmado
 * o en verificación, sin haber empezado.
 */

export type ReminderConfirmation = 'confirmada' | 'no_corresponde';

/** Registra los «Confirmo» de la vuelta. Devuelve, por turno, si quedó registrado. */
export async function registerReminderConfirmations(
  db: NodePgDatabase,
  input: { tenantId: string; customerId: string; messages: { content: Record<string, unknown> }[]; now: Date },
): Promise<Map<string, ReminderConfirmation>> {
  const { tenantId, customerId, now } = input;
  const confirmations = new Map<string, ReminderConfirmation>();

  for (const message of input.messages) {
    const { replyId } = inboundContent(message.content);
    const choice = replyId ? parseChoiceId(replyId) : null;
    if (choice?.kind !== 'reminder' || choice.action !== 'confirm' || confirmations.has(choice.appointmentId)) continue;

    const attendance = await confirmAttendance(db, { tenantId, customerId, appointmentId: choice.appointmentId, now });
    confirmations.set(choice.appointmentId, attendance.ok ? 'confirmada' : 'no_corresponde');
  }
  return confirmations;
}
