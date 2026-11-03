import { describe, expect, it } from 'vitest';
import { isValidMercadoPagoSignature } from '../../../src/modules/mercadopago/signature.js';

// Vector fijo: HMAC-SHA256 en hex de "id:123456;request-id:…;ts:1742505638683;" con el secreto,
// calculado una vez aparte (es el manifest que arma el SDK oficial de Node).
const SECRET = 'secreto-de-prueba';
const REQUEST_ID = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';
const DATA_ID = '123456';
const HASH = 'bcce5e15e1955e354a9c2fd1535970eb7492e3b795383f2ad86b6187526e9ad6';
const SIGNATURE = `ts=1742505638683,v1=${HASH}`;

const valid = { signature: SIGNATURE, requestId: REQUEST_ID, dataId: DATA_ID };

describe('isValidMercadoPagoSignature (x-signature)', () => {
  it('acepta la firma que Mercado Pago calcula con la clave secreta de la aplicación', () => {
    expect(isValidMercadoPagoSignature(valid, SECRET)).toBe(true);
  });

  it('acepta las partes en otro orden y con espacios', () => {
    expect(isValidMercadoPagoSignature({ ...valid, signature: ` v1=${HASH} , ts=1742505638683` }, SECRET)).toBe(true);
  });

  it('rechaza la misma firma con otra clave', () => {
    expect(isValidMercadoPagoSignature(valid, 'otra-clave')).toBe(false);
  });

  it.each([
    ['otro pago', { dataId: '123457' }],
    ['otro pedido', { requestId: 'otro-request-id' }],
    ['otra hora', { signature: `ts=1742505638684,v1=${HASH}` }],
  ])('rechaza la firma de %s', (_case, change) => {
    expect(isValidMercadoPagoSignature({ ...valid, ...change }, SECRET)).toBe(false);
  });

  it.each([
    ['sin encabezado', undefined],
    ['sin ts', `v1=${HASH}`],
    ['sin v1', 'ts=1742505638683'],
    ['con un ts que no es un número', `ts=ayer,v1=${HASH}`],
    ['cortada', SIGNATURE.slice(0, -2)],
    ['basura', 'esto-no-es-una-firma'],
  ])('rechaza una firma %s', (_case, signature) => {
    expect(isValidMercadoPagoSignature({ ...valid, signature }, SECRET)).toBe(false);
  });

  it('rechaza un aviso sin id del pago: no hay qué consultar', () => {
    expect(isValidMercadoPagoSignature({ ...valid, dataId: undefined }, SECRET)).toBe(false);
  });
});
