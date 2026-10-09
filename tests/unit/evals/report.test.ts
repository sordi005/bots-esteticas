import { describe, expect, it } from 'vitest';
import type { EvalResult } from '../../evals/evaluate.js';
import { estimateCostUsd, formatReport, type CaseReport } from '../../evals/report.js';

const MILLION = 1_000_000;

function result(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    texto: 'Hola',
    tipo: 'text',
    opciones: [],
    herramientas: [],
    outcome: 'replied',
    tokens: { entrada: 1_000, salida: 200, cacheLectura: 0, cacheEscritura: 0 },
    latenciaMs: 1_234,
    ...overrides,
  };
}

describe('estimateCostUsd', () => {
  it('cobra US$ 0,10 por millón de entrada', () => {
    expect(estimateCostUsd({ entrada: MILLION, salida: 0, cacheLectura: 0, cacheEscritura: 0 })).toBeCloseTo(0.1, 10);
    expect(estimateCostUsd({ entrada: 3 * MILLION, salida: 0, cacheLectura: 0, cacheEscritura: 0 })).toBeCloseTo(0.3, 10);
  });

  it('cobra US$ 0,50 por millón de salida', () => {
    expect(estimateCostUsd({ entrada: 0, salida: MILLION, cacheLectura: 0, cacheEscritura: 0 })).toBeCloseTo(0.5, 10);
    expect(estimateCostUsd({ entrada: 0, salida: 200_000, cacheLectura: 0, cacheEscritura: 0 })).toBeCloseTo(0.1, 10);
  });

  it('cobra la lectura de caché a US$ 0,01 por millón', () => {
    expect(estimateCostUsd({ entrada: 0, salida: 0, cacheLectura: MILLION, cacheEscritura: 0 })).toBeCloseTo(0.01, 10);
  });

  it('suma todo, y sin tokens no cuesta nada', () => {
    expect(
      estimateCostUsd({ entrada: 2 * MILLION, salida: MILLION, cacheLectura: 10 * MILLION, cacheEscritura: 0 }),
    ).toBeCloseTo(0.2 + 0.5 + 0.1, 10);
    expect(estimateCostUsd({ entrada: 0, salida: 0, cacheLectura: 0, cacheEscritura: 0 })).toBe(0);
  });

  it('la escritura de caché cuesta más que la entrada común', () => {
    const write = estimateCostUsd({ entrada: 0, salida: 0, cacheLectura: 0, cacheEscritura: MILLION });

    expect(write).toBeGreaterThan(0.1);
  });
});

describe('formatReport', () => {
  const reports: CaseReport[] = [
    {
      nombre: 'precio_semi_simple',
      resultado: result({ herramientas: ['buscar_servicios'] }),
      motivos: [],
    },
    {
      nombre: 'precio_desde',
      resultado: result({
        herramientas: ['buscar_servicios', 'consultar_informacion'],
        tokens: { entrada: 3_000, salida: 400, cacheLectura: 500, cacheEscritura: 0 },
        latenciaMs: 2_500,
      }),
      motivos: ['No menciona "28.000"', 'Menciona "$" y no debería'],
    },
  ];

  it('marca cada caso con ✓ o ✗ y su nombre', () => {
    const lines = formatReport(reports, 'claude-haiku-5-5').split('\n');

    expect(lines.some((line) => /✓\s+precio_semi_simple|precio_semi_simple\s+✓/.test(line))).toBe(true);
    expect(lines.some((line) => /✗\s+precio_desde|precio_desde\s+✗/.test(line))).toBe(true);
  });

  it('muestra las herramientas, o un guion si no hubo', () => {
    const report = formatReport(
      [
        { nombre: 'con_herramientas', resultado: result({ herramientas: ['buscar_servicios', 'consultar_informacion'] }), motivos: [] },
        { nombre: 'sin_herramientas', resultado: result(), motivos: [] },
      ],
      'm',
    );
    const withTools = report.split('\n').find((line) => line.includes('con_herramientas'));
    const withoutTools = report.split('\n').find((line) => line.includes('sin_herramientas'));

    expect(withTools).toContain('buscar_servicios, consultar_informacion');
    expect(withoutTools).toMatch(/\s-\s/);
  });

  it('muestra los tokens, la latencia y el motivo del fallo en la fila del caso', () => {
    const line = formatReport(reports, 'm')
      .split('\n')
      .find((l) => l.includes('precio_desde'));

    expect(line).toContain('3.000');
    expect(line).toContain('400');
    expect(line).toContain('2.500');
    expect(line).toContain('No menciona "28.000"');
    expect(line).toContain('Menciona "$" y no debería');
  });

  it('muestra la respuesta de los casos que fallaron, con sus opciones, y no la de los que pasaron', () => {
    const report = formatReport(
      [
        { nombre: 'paso', resultado: result({ texto: 'Sale $18.000' }), motivos: [] },
        {
          nombre: 'fallo',
          resultado: result({
            texto: 'No puedo cambiar precios',
            opciones: [{ id: 'servicio:1', titulo: 'Esmaltado…', descripcion: null }],
          }),
          motivos: ['No menciona "18.000"'],
        },
      ],
      'm',
    );

    expect(report).toContain('fallo: «No puedo cambiar precios» [Esmaltado…]');
    expect(report).not.toContain('Sale $18.000');
  });

  it('no agrega la sección de respuestas si todo pasó o si el caso se cayó sin respuesta', () => {
    const allPassed = formatReport([{ nombre: 'paso', resultado: result(), motivos: [] }], 'm');
    const crashed = formatReport([{ nombre: 'caido', resultado: null, motivos: ['Error: 500'] }], 'm');

    expect(allPassed).not.toContain('Respuestas de los casos que fallaron');
    expect(crashed).not.toContain('Respuestas de los casos que fallaron');
  });

  it('cuenta los aciertos', () => {
    expect(formatReport(reports, 'm')).toContain('Aciertos: 1/2');
    expect(formatReport(reports.slice(0, 1), 'm')).toContain('Aciertos: 1/1');
  });

  it('suma los tokens y estima el costo en dólares', () => {
    const report = formatReport(reports, 'm');

    // 4.000 de entrada y 600 de salida: US$ 0,0004 + US$ 0,0003 + 500 de caché (US$ 0,000005).
    expect(report).toContain('4.000 de entrada');
    expect(report).toContain('600 de salida');
    expect(report).toContain('US$ 0,0007');
  });

  it('un caso que no llegó a correr (error) cuenta como fallo y muestra el motivo', () => {
    const report = formatReport(
      [{ nombre: 'se_cayo', resultado: null, motivos: ['Error: la API no respondió'] }],
      'm',
    );
    const line = report.split('\n').find((l) => l.includes('se_cayo'));

    expect(line).toMatch(/✗/);
    expect(line).toContain('Error: la API no respondió');
    expect(report).toContain('Aciertos: 0/1');
    expect(report).toContain('US$ 0,0000');
  });

  it('nombra el modelo y la fecha de los precios', () => {
    const report = formatReport(reports, 'claude-haiku-5-5');

    expect(report).toContain('claude-haiku-5-5');
    expect(report).toContain('06/10/2026');
  });
});
