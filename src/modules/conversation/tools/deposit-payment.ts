import { eq } from 'drizzle-orm';
import { ensurePaymentLink } from '../../mercadopago/payment-link.js';
import type { CustomerAppointment } from '../../scheduling/customer-appointments.js';
import { tenantSettings } from '../../tenants/schema.js';
import { formatPesos } from '../format.js';
import { handOff } from '../handoff.js';
import { formatDeadline } from './appointment-content.js';
import type { ToolContext } from './tool.js';

/**
 * Los datos para pagar la seña (4.5, 6.4): los escribe el código, nunca el modelo. Los usan
 * `crear_reserva` (en la misma respuesta que la reserva) y `generar_pago_sena` (si los pide de nuevo).
 */

/** Lo que el modelo le pasa a la clienta, según el medio. */
export const PAYMENT_INSTRUCTIONS =
  'En esta misma respuesta pasale los datos de «pago» tal cual (sirve «pago.texto») y pedile la foto del comprobante. No inventes otros datos.';
export const MERCADOPAGO_PAYMENT_INSTRUCTIONS =
  'En esta misma respuesta pasale el link de «pago» tal cual (sirve «pago.texto»). No le pidas comprobante: cuando Mercado Pago acredita el pago, el sistema le avisa por acá. No inventes otros datos.';

export type DepositPayment =
  | {
      kind: 'transfer' | 'mercadopago';
      /** Lo que lee el modelo, en `pago`. */
      content: Record<string, string>;
      /** Qué hacer con `pago`: va en el `mensaje` de la herramienta. */
      instructions: string;
      /** Lo que tiene que aparecer en la respuesta: el alias (o el CBU si no hay alias, D4), o el link. */
      mustMention: string;
    }
  /** No hay cómo cobrarla por acá: ya derivó a una persona (motivo «pago»). */
  | { kind: 'derived'; when: string; reason: string };

/** Lo que se le cuenta a la dueña en la derivación. */
const NO_TRANSFER_DATA = 'Reservó un turno con seña y no hay alias ni CBU cargados para cobrarla';
const MERCADOPAGO_NOT_CONNECTED = 'Reservó un turno con seña por Mercado Pago, que no está conectado';
const MERCADOPAGO_FAILED = 'Reservó un turno con seña y Mercado Pago no generó el link de pago';

async function derive(ctx: ToolContext, reason: string): Promise<DepositPayment> {
  const { when } = await handOff(ctx.db, {
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
    reason: 'payment_issue',
    summary: reason,
    now: ctx.now,
  });
  return { kind: 'derived', when, reason };
}

/**
 * Cómo pagar la seña pendiente de un turno, con el medio que se guardó al reservar: el link de
 * Mercado Pago o los datos de la transferencia. Si no hay cómo cobrarla por acá (Mercado Pago sin
 * conectar o sin link, o sin alias ni CBU), deriva sola: el modelo no inventa nada.
 */
export async function depositPayment(
  ctx: ToolContext,
  appointment: CustomerAppointment,
): Promise<DepositPayment | null> {
  const { deposit } = appointment;
  if (deposit?.status !== 'pending') return null;

  const amount = formatPesos(deposit.amountCents);
  const deadline = formatDeadline(deposit.expiresAt, ctx.now, ctx.timeZone);

  if (deposit.method === 'mercadopago') {
    if (!ctx.mercadoPago) return derive(ctx, MERCADOPAGO_NOT_CONNECTED);
    const link = await ensurePaymentLink(
      { db: ctx.db, ...ctx.mercadoPago },
      { tenantId: ctx.tenantId, appointmentId: appointment.id, title: `Seña: ${appointment.serviceName}`, now: ctx.now },
    );
    if (link.kind === 'not_connected') return derive(ctx, MERCADOPAGO_NOT_CONNECTED);
    if (link.kind !== 'link') return derive(ctx, MERCADOPAGO_FAILED);
    return {
      kind: 'mercadopago',
      content: {
        medio: 'Mercado Pago',
        monto: amount,
        pagarHasta: deadline,
        link: link.url,
        texto: `Para confirmarlo, pagá la seña de ${amount} con Mercado Pago hasta ${deadline} en este link: ${link.url}`,
      },
      instructions: MERCADOPAGO_PAYMENT_INSTRUCTIONS,
      mustMention: link.url,
    };
  }

  const [settings] = await ctx.db
    .select({
      alias: tenantSettings.transferAlias,
      cbu: tenantSettings.transferCbu,
      holder: tenantSettings.transferAccountHolder,
    })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, ctx.tenantId));

  const alias = settings?.alias ?? null;
  const cbu = settings?.cbu ?? null;
  if (!alias && !cbu) return derive(ctx, NO_TRANSFER_DATA);

  const holder = settings?.holder ?? null;
  const destination = [
    alias ? `al alias ${alias}` : null,
    cbu ? `${alias ? '(o al ' : 'al '}CBU ${cbu}${alias ? ')' : ''}` : null,
    holder ? `(titular: ${holder})` : null,
  ]
    .filter((part) => part !== null)
    .join(' ');

  return {
    kind: 'transfer',
    content: {
      medio: 'transferencia',
      monto: amount,
      pagarHasta: deadline,
      ...(alias ? { alias } : {}),
      ...(cbu ? { cbu } : {}),
      ...(holder ? { titular: holder } : {}),
      texto: `Para confirmarlo, transferí la seña de ${amount} ${destination} hasta ${deadline} y mandame por acá la foto del comprobante.`,
    },
    instructions: PAYMENT_INSTRUCTIONS,
    mustMention: alias ?? cbu ?? '',
  };
}

/** El mensaje para el modelo cuando derivó por la seña. */
export function derivedPaymentMessage(when: string): string {
  return (
    'Los datos para pagar la seña se los pasa una persona del equipo por este chat: la conversación quedó ' +
    `derivada y le responde ${when}. Decíselo con esas palabras («te va a responder por acá ${when}»), sin inventar ` +
    'alias, CBU ni links. «derivar» va null: ya derivó la herramienta.'
  );
}
