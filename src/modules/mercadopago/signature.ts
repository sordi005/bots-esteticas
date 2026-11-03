import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Valida el encabezado `x-signature` de un webhook de Mercado Pago (8.3): `ts=<segundos>,v1=<hash>`,
 * donde el hash es HMAC-SHA256 en hex de `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` con la
 * clave secreta de la aplicación. Es el manifest que arma el SDK oficial de Node
 * (src/utils/webhook): una parte que no llegó se omite. La comparación es de tiempo constante.
 *
 * Un aviso sin `data.id` se rechaza: sin el id no hay pago que consultar.
 */
export interface MercadoPagoSignatureInput {
  signature: string | undefined;
  requestId: string | undefined;
  /** El `data.id` de la URL del aviso. */
  dataId: string | undefined;
}

export function isValidMercadoPagoSignature(input: MercadoPagoSignatureInput, secret: string): boolean {
  const dataId = input.dataId?.trim();
  if (!input.signature || !dataId) return false;

  const parts = new Map<string, string>();
  for (const part of input.signature.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    parts.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  const ts = parts.get('ts');
  const received = parts.get('v1');
  if (!ts || !/^\d+$/.test(ts) || !received) return false;

  const requestId = input.requestId?.trim();
  const manifest = [`id:${dataId}`, ...(requestId ? [`request-id:${requestId}`] : []), `ts:${ts}`].join(';') + ';';
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');
  return received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
