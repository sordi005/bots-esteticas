/**
 * El teléfono de la dueña para los avisos (8.2), como lo identifica WhatsApp: `+` y el número
 * internacional. Contra ese número se reconocen sus respuestas a los avisos (6.5), así que un
 * celular argentino va con el 9 y sin el 15 (+549 + área + número): es lo que manda WhatsApp.
 */
export type OwnerPhoneResult = { ok: true; phone: string } | { ok: false; reason: string };

const E164_DIGITS = /^[1-9][0-9]{7,14}$/;

export function parseOwnerPhone(input: string): OwnerPhoneResult {
  const digits = input.replace(/[\s()+-]/g, '');
  if (!E164_DIGITS.test(digits)) {
    return { ok: false, reason: 'No es un teléfono internacional: por ejemplo +5492615550000' };
  }
  if (digits.startsWith('54') && !digits.startsWith('549')) {
    return {
      ok: false,
      reason: 'WhatsApp identifica a un celular argentino como +549 + área + número, sin el 15: por ejemplo +5492615550000',
    };
  }
  return { ok: true, phone: `+${digits}` };
}
