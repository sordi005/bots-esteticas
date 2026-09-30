/**
 * Intervalo de tiempo semiabierto [start, end): incluye el inicio y excluye el fin.
 * Así un turno que termina a las 11:00 y otro que empieza a las 11:00 no se superponen.
 * En Postgres se guarda como `tstzrange`.
 */
export interface TimestampRange {
  start: Date;
  end: Date;
}

export function formatTimestampRange({ start, end }: TimestampRange): string {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Rango con una fecha inválida');
  }
  if (end.getTime() <= start.getTime()) {
    throw new Error('Rango inválido: el fin tiene que ser posterior al inicio');
  }
  return `[${start.toISOString()},${end.toISOString()})`;
}

// Postgres escribe los límites como "2026-10-03 18:30:00.25+00" (o con offset +05:30).
const POSTGRES_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Lee un `tstzrange` de Postgres. Solo acepta rangos finitos de la forma [inicio, fin). */
export function parseTimestampRange(value: string): TimestampRange {
  if (!value.startsWith('[') || !value.endsWith(')')) {
    throw new Error(`Rango no soportado (se espera [inicio, fin)): ${value}`);
  }

  const bounds = value.slice(1, -1).split(',');
  if (bounds.length !== 2) {
    throw new Error(`Rango mal formado: ${value}`);
  }
  const [lower = '', upper = ''] = bounds;

  return { start: parseBound(lower), end: parseBound(upper) };
}

function parseBound(bound: string): Date {
  const raw = bound.replaceAll('"', '').trim();
  const match = POSTGRES_TIMESTAMP.exec(raw);
  if (!match) {
    throw new Error(`Límite de rango inválido o infinito: "${raw}"`);
  }

  const [, date, time, offset = 'Z'] = match;
  const parsed = new Date(`${date ?? ''}T${time ?? ''}${normalizeOffset(offset)}`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Fecha inválida en el rango: "${raw}"`);
  }
  return parsed;
}

/** "+00" → "+00:00", "-0300" → "-03:00", "Z" queda igual. */
function normalizeOffset(offset: string): string {
  if (offset === 'Z') return offset;
  const digits = offset.slice(1).replace(':', '');
  return `${offset.charAt(0)}${digits.slice(0, 2)}:${digits.slice(2, 4) || '00'}`;
}
