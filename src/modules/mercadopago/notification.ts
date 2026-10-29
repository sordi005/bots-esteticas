import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { scheduleJob } from '../jobs/queue.js';
import { tenants } from '../tenants/schema.js';

/**
 * Qué dice un aviso del webhook de Mercado Pago (8.3). Mercado Pago agrega `data.id` y `type` a la
 * URL de notificación, y la firma se calcula sobre ese `data.id`: el id del pago sale de ahí, no del
 * cuerpo. Solo se procesan los avisos de tipo `payment`; el resto se contesta 200 y se ignora.
 */
export type MercadoPagoNotification = { kind: 'payment'; paymentId: string } | { kind: 'ignored'; type: string | null };

const body = z.object({ type: z.string().optional() }).loose();

export function parseMercadoPagoNotification(
  query: Record<string, string | undefined>,
  payload: unknown,
): MercadoPagoNotification {
  const parsedBody = body.safeParse(payload);
  const type = query.type ?? (parsedBody.success ? parsedBody.data.type : undefined) ?? null;
  const paymentId = query['data.id']?.trim();

  if (type !== 'payment' || !paymentId) return { kind: 'ignored', type };
  return { kind: 'payment', paymentId };
}

export type RecordedNotification = 'scheduled' | 'unknown_tenant';

/**
 * Guarda el aviso de un pago programando la tarea "procesar un pago de Mercado Pago" con el id del
 * pago como clave (decisión 40): un aviso repetido es la misma fila. La tarea consulta el pago a la
 * API; el aviso no se cree.
 */
export async function recordPaymentNotification(
  db: NodePgDatabase,
  input: { tenantId: string; paymentId: string; now: Date },
): Promise<RecordedNotification> {
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.tenantId));
  if (!tenant) return 'unknown_tenant';

  await scheduleJob(db, {
    tenantId: input.tenantId,
    kind: 'process_mercadopago_payment',
    key: input.paymentId,
    runAt: input.now,
  });
  return 'scheduled';
}
