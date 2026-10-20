import { describe, expect, it } from 'vitest';
import {
  CODE_ONLY_HANDOFF_REASONS,
  HANDOFF_SUMMARY_MIN_WORDS,
  MODEL_HANDOFF_REASONS,
  MODEL_HANDOFF_REASON_NAMES,
  isFillerSummary,
} from '../../../src/modules/conversation/handoff-reasons.js';
import { handoffReason } from '../../../src/modules/conversation/schema.js';

describe('MODEL_HANDOFF_REASONS: los motivos que ve el modelo (4.8)', () => {
  it('son los ocho de la lista cerrada, con nombres en español', () => {
    expect([...MODEL_HANDOFF_REASON_NAMES]).toEqual([
      'pedido_de_la_clienta',
      'queja',
      'tema_sensible',
      'imagen',
      'consulta_previa',
      'fuera_de_catalogo',
      'excepcion',
      'no_entiende',
    ]);
  });

  it('cada motivo se guarda con el motivo de la base que le corresponde, y los de la base son estos más los del código', () => {
    const stored = MODEL_HANDOFF_REASON_NAMES.map((name) => MODEL_HANDOFF_REASONS[name].reason);

    expect(stored).toEqual([
      'customer_request',
      'complaint',
      'sensitive_topic',
      'unsupported_media',
      'requires_consultation',
      'off_catalog',
      'policy_exception',
      'not_understood',
    ]);
    expect([...stored, ...CODE_ONLY_HANDOFF_REASONS].sort()).toEqual([...handoffReason.enumValues].sort());
  });

  it('el modelo no puede elegir un motivo que es solo del código (4.8)', () => {
    const stored: string[] = MODEL_HANDOFF_REASON_NAMES.map((name) => MODEL_HANDOFF_REASONS[name].reason);

    expect(CODE_ONLY_HANDOFF_REASONS).toEqual(['payment_issue']);
    expect(stored).not.toContain('payment_issue');
  });

  it('cada motivo trae una descripción para el modelo', () => {
    for (const name of MODEL_HANDOFF_REASON_NAMES) {
      expect(MODEL_HANDOFF_REASONS[name].description.length).toBeGreaterThan(15);
    }
    expect(MODEL_HANDOFF_REASONS.tema_sensible.description).toMatch(/salud/);
    expect(MODEL_HANDOFF_REASONS.fuera_de_catalogo.description).toMatch(/aceptó|insistió/);
  });
});

describe('isFillerSummary: resúmenes de relleno que no derivan (4.8)', () => {
  it('un resumen real tiene por lo menos 3 palabras', () => {
    expect(HANDOFF_SUMMARY_MIN_WORDS).toBe(3);
  });

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
    ['vacío', ''],
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
