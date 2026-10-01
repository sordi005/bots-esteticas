import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
} from '../../../src/shared/encryption.js';

const key = randomBytes(32);
const CONTEXT = 'tenant-a:whatsapp';

describe('encryptSecret y decryptSecret (AES-256-GCM, sección 9.1)', () => {
  it('lo que se cifra se descifra igual', () => {
    const secret = encryptSecret('EAAG-token-de-prueba', key, CONTEXT);

    expect(decryptSecret(secret, key, CONTEXT)).toBe('EAAG-token-de-prueba');
  });

  it('el texto cifrado no contiene el secreto y cambia en cada cifrado', () => {
    const first = encryptSecret('EAAG-token-de-prueba', key, CONTEXT);
    const second = encryptSecret('EAAG-token-de-prueba', key, CONTEXT);

    expect(first.ciphertext.toString('latin1')).not.toContain('EAAG');
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.iv).toHaveLength(12);
    expect(first.authTag).toHaveLength(16);
  });

  it('falla si alguien modificó el texto cifrado', () => {
    const secret = encryptSecret('EAAG-token-de-prueba', key, CONTEXT);
    const tampered = Buffer.from(secret.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    expect(() => decryptSecret({ ...secret, ciphertext: tampered }, key, CONTEXT)).toThrow();
  });

  it('falla con otra clave', () => {
    const secret = encryptSecret('EAAG-token-de-prueba', key, CONTEXT);

    expect(() => decryptSecret(secret, randomBytes(32), CONTEXT)).toThrow();
  });

  it('falla si la credencial de un negocio se copia a otro: el contexto es parte del cifrado', () => {
    const secret = encryptSecret('EAAG-token-de-prueba', key, CONTEXT);

    expect(() => decryptSecret(secret, key, 'tenant-b:whatsapp')).toThrow();
  });
});

describe('parseEncryptionKey', () => {
  it('acepta 32 bytes en base64', () => {
    const encoded = randomBytes(32).toString('base64');

    expect(parseEncryptionKey(encoded)).toHaveLength(32);
  });

  it.each([
    ['muy corta', randomBytes(16).toString('base64')],
    ['que no es base64', 'esto-no-es-base64!'],
  ])('rechaza una clave %s', (_case, encoded) => {
    expect(() => parseEncryptionKey(encoded)).toThrow(/32 bytes/);
  });
});
