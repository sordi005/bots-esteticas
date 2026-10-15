import { describe, expect, it } from 'vitest';
import {
  HANDOFF_SUMMARY_MAX_LENGTH,
  SENSITIVE_TOPIC_SUMMARY,
  buildHandoffSummary,
} from '../../../src/modules/conversation/handoff.js';

describe('buildHandoffSummary: el resumen que ve la dueña (4.8)', () => {
  it('con un tema sensible guarda siempre el resumen fijo y descarta el del modelo (regla 9)', () => {
    expect(SENSITIVE_TOPIC_SUMMARY).toBe('Tema sensible: ver la conversación');
    expect(buildHandoffSummary('sensitive_topic', 'Está embarazada y es alérgica al látex')).toBe(
      SENSITIVE_TOPIC_SUMMARY,
    );
    expect(buildHandoffSummary('sensitive_topic', '')).toBe(SENSITIVE_TOPIC_SUMMARY);
  });

  it.each([
    'customer_request',
    'complaint',
    'unsupported_media',
    'requires_consultation',
    'off_catalog',
    'policy_exception',
    'not_understood',
  ] as const)('con el motivo %s guarda el resumen del modelo', (reason) => {
    expect(buildHandoffSummary(reason, 'Pide hablar con Mica')).toBe('Pide hablar con Mica');
  });

  it('es de una línea: los saltos y los espacios repetidos se juntan, y se recortan los bordes', () => {
    expect(buildHandoffSummary('complaint', '  Se quejó del\nturno   de ayer\r\ny pide\tdevolución  ')).toBe(
      'Se quejó del turno de ayer y pide devolución',
    );
  });

  it('se recorta a 200 caracteres, con puntos suspensivos al final', () => {
    expect(HANDOFF_SUMMARY_MAX_LENGTH).toBe(200);
    const long = buildHandoffSummary('complaint', 'a'.repeat(500));

    expect(long).toHaveLength(HANDOFF_SUMMARY_MAX_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });

  it('un resumen de exactamente 200 caracteres queda igual', () => {
    const exact = 'b'.repeat(HANDOFF_SUMMARY_MAX_LENGTH);

    expect(buildHandoffSummary('complaint', exact)).toBe(exact);
  });
});
