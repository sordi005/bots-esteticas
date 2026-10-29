import { z } from 'zod';

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
