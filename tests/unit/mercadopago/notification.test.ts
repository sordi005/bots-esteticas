import { describe, expect, it } from 'vitest';
import { parseMercadoPagoNotification } from '../../../src/modules/mercadopago/notification.js';

describe('parseMercadoPagoNotification', () => {
  it('el id del pago sale de la URL, que es lo que firma Mercado Pago', () => {
    const notification = parseMercadoPagoNotification(
      { type: 'payment', 'data.id': '111' },
      { type: 'payment', data: { id: '999' } },
    );

    expect(notification).toEqual({ kind: 'payment', paymentId: '111' });
  });

  it('sin type en la URL, lo toma del cuerpo', () => {
    expect(parseMercadoPagoNotification({ 'data.id': '111' }, { type: 'payment' })).toEqual({
      kind: 'payment',
      paymentId: '111',
    });
  });

  it.each([
    ['una orden', { type: 'topic_merchant_order_wh', 'data.id': '1' }, 'topic_merchant_order_wh'],
    ['la desvinculación de una cuenta', { type: 'mp-connect', 'data.id': '1' }, 'mp-connect'],
    ['un pago sin id', { type: 'payment' }, 'payment'],
  ])('ignora %s', (_case, query, type) => {
    expect(parseMercadoPagoNotification(query, null)).toEqual({ kind: 'ignored', type });
  });

  it('ignora un aviso sin tipo', () => {
    expect(parseMercadoPagoNotification({ 'data.id': '1' }, 'no es JSON')).toEqual({ kind: 'ignored', type: null });
  });
});
