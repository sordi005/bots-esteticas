import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado de credenciales de terceros con AES-256-GCM (sección 9.1).
 *
 * `context` es un dato asociado (AAD): no se cifra, pero queda atado al texto cifrado. Si se
 * cifra con "negocio A:whatsapp", descifrar con "negocio B:whatsapp" falla: una credencial
 * copiada a la fila de otro negocio no sirve.
 */
export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export function encryptSecret(plaintext: string, key: Buffer, context: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Lanza un error si la clave, el contexto o el texto cifrado no coinciden. */
export function decryptSecret(secret: EncryptedSecret, key: Buffer, context: string): string {
  const decipher = createDecipheriv(ALGORITHM, key, secret.iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(secret.authTag);
  return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
}

/** La clave viene de una variable de entorno, en base64. */
export function parseEncryptionKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== encoded.trim()) {
    throw new Error('La clave de cifrado tiene que ser de 32 bytes en base64');
  }
  return key;
}
