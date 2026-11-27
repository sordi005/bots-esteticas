import { describe, expect, it } from 'vitest';
import { coexistenceSince } from '../../../src/modules/whatsapp/coexistence.js';

/** Desde cuándo el número está en coexistencia (8.1, H14): la alerta de ecos cuenta desde ahí. */
describe('coexistenceSince: qué fecha guarda pnpm whatsapp:connect', () => {
  const NOW = new Date('2026-11-26T15:00:00Z');
  const BEFORE = new Date('2026-11-01T12:00:00Z');

  it('al confirmar Meta la coexistencia por primera vez, desde ahora', () => {
    expect(coexistenceSince('coexistence', null, NOW)).toEqual(NOW);
  });

  it('si ya estaba en coexistencia, conserva la fecha: reconectar no reinicia la cuenta de días', () => {
    expect(coexistenceSince('coexistence', BEFORE, NOW)).toEqual(BEFORE);
  });

  it.each(['api_only', 'not_connected'] as const)('si Meta dice %s, ya no está en coexistencia', (status) => {
    expect(coexistenceSince(status, BEFORE, NOW)).toBeNull();
  });

  it('si Meta no contestó algo claro, deja lo que había', () => {
    expect(coexistenceSince('unknown', BEFORE, NOW)).toEqual(BEFORE);
    expect(coexistenceSince('unknown', null, NOW)).toBeNull();
  });
});
