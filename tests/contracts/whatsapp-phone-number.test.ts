import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coexistenceStatus } from '../../src/modules/whatsapp/coexistence.js';

/**
 * Si el número está en coexistencia (8.1, H13): `GET /{phone-number-id}?fields=is_on_biz_app,platform_type`.
 * Ejemplo oficial, copiado tal cual:
 * developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
 */
const official = JSON.parse(
  readFileSync(new URL('whatsapp/phone-number-coexistence.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('coexistenceStatus: si el número usa la app y la API a la vez', () => {
  it('con is_on_biz_app en true y platform_type CLOUD_API está en coexistencia', () => {
    expect(coexistenceStatus(official)).toBe('coexistence');
  });

  it('un número que no está en la app de WhatsApp Business es solo de la API: no llegan ecos', () => {
    expect(coexistenceStatus({ ...official, is_on_biz_app: false })).toBe('api_only');
  });

  it('si no está registrado en la Cloud API, no está conectado', () => {
    expect(coexistenceStatus({ ...official, platform_type: 'NOT_APPLICABLE' })).toBe('not_connected');
  });

  it('una respuesta que no se entiende no se da por buena', () => {
    expect(coexistenceStatus({ error: { message: 'Unsupported get request' } })).toBe('unknown');
  });
});
