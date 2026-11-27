import { describe, expect, it } from 'vitest';
import { GoogleApiError } from '../../../src/modules/calendar/google-auth.js';
import { MercadoPagoApiError } from '../../../src/modules/mercadopago/client.js';
import { WhatsAppApiError } from '../../../src/modules/whatsapp/client.js';
import { rejectedCredential } from '../../../src/shared/credential-rejection.js';

/**
 * Errores permanentes (6.7, decisión 55): una credencial rechazada no se arregla reintentando. Lo
 * decide el cliente de cada tercero.
 */
describe('rejectedCredential: qué credencial rechazó el tercero', () => {
  it.each([0, 3, 10, 190, 200, 250, 299, 131005])('Meta con el código %i rechaza el token de WhatsApp', (code) => {
    expect(rejectedCredential(new WhatsAppApiError('Meta rechazó el mensaje', 401, code))).toBe('whatsapp');
  });

  it.each([131047, 131026, 130429, 100, 300, 199])('Meta con el código %i es un error que se reintenta', (code) => {
    expect(rejectedCredential(new WhatsAppApiError('Meta rechazó el mensaje', 400, code))).toBeNull();
  });

  it('un error de Meta sin código se reintenta', () => {
    expect(rejectedCredential(new WhatsAppApiError('Meta respondió 500', 500, null))).toBeNull();
  });

  it.each(['invalid_grant', 'invalid_client'])('Mercado Pago con %s rechaza el token de la cuenta', (code) => {
    expect(rejectedCredential(new MercadoPagoApiError('Mercado Pago rechazó el token', 400, code))).toBe('mercadopago');
  });

  it('otro error de Mercado Pago se reintenta', () => {
    expect(rejectedCredential(new MercadoPagoApiError('Mercado Pago respondió 500', 500, 'internal_error'))).toBeNull();
  });

  it.each([401, 403])('Google con %i rechaza la cuenta de servicio o el permiso del calendario', (status) => {
    expect(rejectedCredential(new GoogleApiError('Google Calendar rechazó la consulta', status, null))).toBe('google');
  });

  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])(
    'Google con 403 por %s se reintenta: el límite de pedidos se arregla esperando',
    (reason) => {
      expect(rejectedCredential(new GoogleApiError('Google Calendar rechazó la consulta', 403, reason))).toBeNull();
    },
  );

  it('Google con 403 por otro motivo (calendario sin compartir) rechaza el permiso', () => {
    expect(rejectedCredential(new GoogleApiError('Google Calendar rechazó la consulta', 403, 'forbidden'))).toBe('google');
  });

  it.each([404, 429, 500])('Google con %i se reintenta', (status) => {
    expect(rejectedCredential(new GoogleApiError('Google Calendar respondió', status, null))).toBeNull();
  });

  it('busca en las causas: un error envuelto sigue siendo permanente', () => {
    const wrapped = new Error('No se pudo enviar el aviso', {
      cause: new WhatsAppApiError('Meta rechazó el mensaje', 401, 190),
    });

    expect(rejectedCredential(wrapped)).toBe('whatsapp');
  });

  it('un error cualquiera, o algo que no es un error, se reintenta', () => {
    expect(rejectedCredential(new Error('timeout'))).toBeNull();
    expect(rejectedCredential('texto')).toBeNull();
  });
});
