import type { EvalResult } from './evaluate.js';

/**
 * El resumen que imprime `pnpm test:evals` al terminar: una tabla con cada caso, los aciertos,
 * los tokens y el costo estimado. Es puro (devuelve el texto) para poder probarlo sin la API.
 */

/**
 * Precios de Claude Haiku 5.5 en US$ por millón de tokens, vigentes al 06/10/2026.
 * Revisar la página de precios de Anthropic antes de confiar en el costo de una corrida nueva.
 */
export const PRICES_AS_OF = '06/10/2026';
export const PRICE_USD_PER_MILLION_INPUT = 0.1;
export const PRICE_USD_PER_MILLION_OUTPUT = 0.5;
export const PRICE_USD_PER_MILLION_CACHE_READ = 0.01;
/** Supuesto: la API cobra la escritura de caché a 1,25 veces la entrada. No lo dio el usuario: confirmarlo. */
export const PRICE_USD_PER_MILLION_CACHE_WRITE = 0.125;

const MILLION = 1_000_000;

export function estimateCostUsd(tokens: EvalResult['tokens']): number {
  return (
    (tokens.entrada * PRICE_USD_PER_MILLION_INPUT +
      tokens.salida * PRICE_USD_PER_MILLION_OUTPUT +
      tokens.cacheLectura * PRICE_USD_PER_MILLION_CACHE_READ +
      tokens.cacheEscritura * PRICE_USD_PER_MILLION_CACHE_WRITE) /
    MILLION
  );
}

/** Lo que dejó un caso: `resultado` es null si la corrida se cayó antes de terminar. */
export interface CaseReport {
  nombre: string;
  resultado: EvalResult | null;
  /** Por qué falló. Vacío si pasó (solo puede pasar con un resultado). */
  motivos: string[];
}

const integer = new Intl.NumberFormat('es-AR');
const dollars = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

const passed = (report: CaseReport) => report.resultado !== null && report.motivos.length === 0;

function table(reports: CaseReport[]): string[] {
  const rows = reports.map((report) => {
    const { resultado } = report;
    return {
      caso: report.nombre,
      ok: passed(report) ? '✓' : '✗',
      herramientas: resultado && resultado.herramientas.length > 0 ? resultado.herramientas.join(', ') : '-',
      entrada: resultado ? integer.format(resultado.tokens.entrada) : '-',
      salida: resultado ? integer.format(resultado.tokens.salida) : '-',
      cache: resultado ? integer.format(resultado.tokens.cacheLectura) : '-',
      ms: resultado ? integer.format(resultado.latenciaMs) : '-',
      motivo: report.motivos.join(' | '),
    };
  });
  const header = { caso: 'caso', ok: 'ok', herramientas: 'herramientas', entrada: 'ent', salida: 'sal', cache: 'caché', ms: 'ms', motivo: 'motivo' };
  const all = [header, ...rows];
  const width = (key: keyof typeof header) => Math.max(...all.map((row) => row[key].length));
  const w = {
    caso: width('caso'),
    herramientas: width('herramientas'),
    entrada: width('entrada'),
    salida: width('salida'),
    cache: width('cache'),
    ms: width('ms'),
  };

  return all.map((row) =>
    [
      row.caso.padEnd(w.caso),
      row.ok.padEnd(2),
      row.herramientas.padEnd(w.herramientas),
      row.entrada.padStart(w.entrada),
      row.salida.padStart(w.salida),
      row.cache.padStart(w.cache),
      row.ms.padStart(w.ms),
      row.motivo,
    ]
      .join('  ')
      .trimEnd(),
  );
}

export function formatReport(reports: CaseReport[], model: string): string {
  const total = { entrada: 0, salida: 0, cacheLectura: 0, cacheEscritura: 0 };
  for (const { resultado } of reports) {
    if (!resultado) continue;
    total.entrada += resultado.tokens.entrada;
    total.salida += resultado.tokens.salida;
    total.cacheLectura += resultado.tokens.cacheLectura;
    total.cacheEscritura += resultado.tokens.cacheEscritura;
  }
  const hits = reports.filter(passed).length;

  return [
    `Evaluaciones del agente (modelo: ${model})`,
    '',
    ...table(reports),
    '',
    `Aciertos: ${String(hits)}/${String(reports.length)}`,
    `Tokens: ${integer.format(total.entrada)} de entrada, ${integer.format(total.salida)} de salida, ` +
      `${integer.format(total.cacheLectura)} leídos de caché, ${integer.format(total.cacheEscritura)} escritos en caché`,
    `Costo estimado: US$ ${dollars.format(estimateCostUsd(total))} (precios de Haiku 5.5 al ${PRICES_AS_OF})`,
  ].join('\n');
}
