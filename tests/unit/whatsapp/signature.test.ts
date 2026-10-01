import { describe, expect, it } from 'vitest';
import { isValidSignature } from '../../../src/modules/whatsapp/signature.js';

// Vector fijo: HMAC-SHA256 en hex de BODY con el secreto, calculado una vez aparte.
const SECRET = 'secreto-de-prueba';
const BODY = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
const SIGNATURE = 'sha256=7684209d20e98f747cbaa9c37e9dbcf89184b73c4b7be662da88d486fab52681';

describe('isValidSignature (X-Hub-Signature-256)', () => {
  it('acepta la firma que Meta calcula con el secreto de la app', () => {
    expect(isValidSignature(BODY, SIGNATURE, SECRET)).toBe(true);
  });

  it('rechaza el mismo cuerpo firmado con otro secreto', () => {
    expect(isValidSignature(BODY, SIGNATURE, 'otro-secreto')).toBe(false);
  });

  it('rechaza un cuerpo modificado, aunque sea un byte', () => {
    const tampered = Buffer.from(BODY);
    tampered[2] = tampered[2] === 0x61 ? 0x62 : 0x61;

    expect(isValidSignature(tampered, SIGNATURE, SECRET)).toBe(false);
  });

  it.each([
    ['sin encabezado', undefined],
    ['sin el prefijo sha256=', SIGNATURE.slice('sha256='.length)],
    ['con otro algoritmo', SIGNATURE.replace('sha256=', 'sha1=')],
    ['con caracteres que no son hexadecimales', 'sha256=zz'],
    ['cortada', SIGNATURE.slice(0, -2)],
  ])('rechaza una firma %s', (_case, header) => {
    expect(isValidSignature(BODY, header, SECRET)).toBe(false);
  });
});
