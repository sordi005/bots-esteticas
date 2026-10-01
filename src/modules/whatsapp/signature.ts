import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

/**
 * Valida el encabezado `X-Hub-Signature-256` de un webhook de Meta: HMAC-SHA256 en hex del
 * cuerpo CRUDO, con el App Secret. Se calcula sobre los bytes tal como llegaron: el JSON
 * re-serializado puede cambiar (por ejemplo, los caracteres escapados) y la firma ya no
 * coincidiría. La comparación es de tiempo constante para no filtrar información.
 */
export function isValidSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith(PREFIX)) return false;

  const received = Buffer.from(header.slice(PREFIX.length), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}
