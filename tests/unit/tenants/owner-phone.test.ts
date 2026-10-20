import { describe, expect, it } from 'vitest';
import { parseOwnerPhone } from '../../../src/modules/tenants/owner-phone.js';

/**
 * El teléfono de la dueña se guarda como lo identifica WhatsApp (8.2): contra ese número se
 * reconocen sus respuestas a los avisos (6.5).
 */
describe('parseOwnerPhone', () => {
  it.each([
    ['+5492615550000', '+5492615550000'],
    ['5492615550000', '+5492615550000'],
    ['+54 9 261 555-0000', '+5492615550000'],
    ['+14155552671', '+14155552671'],
  ])('%s se guarda como %s', (input, expected) => {
    expect(parseOwnerPhone(input)).toEqual({ ok: true, phone: expected });
  });

  it('un celular argentino escrito con el 15 se rechaza: WhatsApp lo identifica como 549 + área + número', () => {
    const result = parseOwnerPhone('54261155550000');

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/549/);
  });

  it.each(['', 'abc', '+0123', '12'])('«%s» no es un teléfono', (input) => {
    expect(parseOwnerPhone(input).ok).toBe(false);
  });
});
