import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { deposits } from '../payments/schema.js';
import type { MercadoPagoClient } from './client.js';
import { loadMercadoPagoCredential } from './connection.js';
import { paymentNotificationUrl } from './notification.js';

/**
 * El link de pago de la seña (4.5, 8.3): una preferencia de Checkout Pro con el token del negocio,
 * creada después de reservar (un pedido a otra API no queda dentro de una transacción) y una sola vez
 * por seña. El link queda en la seña para volver a darlo.
 */
export interface PaymentLinkDependencies {
  db: NodePgDatabase;
  logger: Logger;
  client: MercadoPagoClient;
  credentialsKey: Buffer;
  /** Sin barra final: de acá sale la URL de avisos del negocio. */
  publicBaseUrl: string;
}

export type PaymentLink =
  | { kind: 'link'; url: string }
  /** El negocio cobra con Mercado Pago pero no conectó su cuenta. */
  | { kind: 'not_connected' }
  /** Mercado Pago no creó la preferencia (la rechazó o no respondió). */
  | { kind: 'failed' }
  | { kind: 'no_deposit' };

export async function ensurePaymentLink(
  deps: PaymentLinkDependencies,
  input: { tenantId: string; appointmentId: string; title: string; now: Date },
): Promise<PaymentLink> {
  const { db } = deps;
  const { tenantId } = input;
  const [deposit] = await db
    .select({
      id: deposits.id,
      amountCents: deposits.amountCents,
      expiresAt: deposits.expiresAt,
      url: deposits.mercadopagoPaymentUrl,
    })
    .from(deposits)
    .where(and(eq(deposits.tenantId, tenantId), eq(deposits.appointmentId, input.appointmentId)));
  if (!deposit) return { kind: 'no_deposit' };
  if (deposit.url) return { kind: 'link', url: deposit.url };

  const credential = await loadMercadoPagoCredential(db, deps.credentialsKey, tenantId);
  if (!credential) return { kind: 'not_connected' };

  let created: { preferenceId: string; paymentUrl: string };
  try {
    created = await deps.client.createPreference({
      accessToken: credential.accessToken,
      preference: {
        depositId: deposit.id,
        title: input.title,
        amountCents: deposit.amountCents,
        notificationUrl: paymentNotificationUrl(deps.publicBaseUrl, tenantId),
        createdAt: input.now,
        expiresAt: deposit.expiresAt,
      },
    });
  } catch (error) {
    // Lo que sea (un rechazo, la red): la clienta no se queda sin respuesta, la herramienta deriva (4.5).
    deps.logger.warn({ err: error, tenantId, depositId: deposit.id }, 'Mercado Pago no creó la preferencia de la seña');
    return { kind: 'failed' };
  }

  // Si otra vuelta ya guardó un link, vale ese: la clienta recibe siempre el mismo.
  const [saved] = await db
    .update(deposits)
    .set({ mercadopagoPreferenceId: created.preferenceId, mercadopagoPaymentUrl: created.paymentUrl })
    .where(and(eq(deposits.tenantId, tenantId), eq(deposits.id, deposit.id), isNull(deposits.mercadopagoPreferenceId)))
    .returning({ url: deposits.mercadopagoPaymentUrl });
  if (saved?.url) return { kind: 'link', url: saved.url };

  const [existing] = await db
    .select({ url: deposits.mercadopagoPaymentUrl })
    .from(deposits)
    .where(and(eq(deposits.tenantId, tenantId), eq(deposits.id, deposit.id)));
  return existing?.url ? { kind: 'link', url: existing.url } : { kind: 'failed' };
}
