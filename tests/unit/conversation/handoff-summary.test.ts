import { describe, expect, it } from 'vitest';
import {
  HANDOFF_SUMMARY_MAX_LENGTH,
  SENSITIVE_TOPIC_SUMMARY,
  buildHandoffSummary,
  isFillerSummary,
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

describe('isFillerSummary: resúmenes de relleno que no derivan (4.8)', () => {
  // Salieron de las evaluaciones: el modelo emitía la derivación sin haberla decidido.
  it.each([
    ['la palabra placeholder', 'placeholder'],
    ['una letra', 'x'],
    ['una palabra suelta', 'Ignorar'],
    ['dos palabras', 'Reclamo atención'],
    ['relleno de más de tres palabras', 'placeholder del resumen acá'],
    ['texto de prueba', 'esto es una prueba'],
    ['lorem ipsum', 'Lorem ipsum dolor sit'],
    ['solo signos y espacios', '  ...  ---  '],
  ])('%s es relleno', (_case, summary) => {
    expect(isFillerSummary(summary)).toBe(true);
  });

  it.each([
    'Reclamo por mala atención en su última visita',
    'Quiere hablar con una persona',
    'Pide cancelar fuera de plazo el turno del mar 13/10 17:00',
    'Consulta por masajes, que no están en el catálogo',
  ])('«%s» es un resumen real', (summary) => {
    expect(isFillerSummary(summary)).toBe(false);
  });
});
