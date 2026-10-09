/**
 * Qué horarios ofrece el asistente (4.3). Los elige el código, no el modelo: la primera libre
 * y cada una de las siguientes al menos `minGapMinutes` después de la anterior. Así no se
 * ofrecen 9:00, 9:15 y 9:30, que a la clienta le sirven de muy poco, sino 9:00, 10:30 y 12:00.
 * Función pura.
 */

/** Separación mínima entre las opciones ofrecidas [S] (4.3). */
export const MIN_GAP_BETWEEN_OFFERED_SLOTS_MINUTES = 90;

const MINUTE_MS = 60_000;

export interface SpreadSlots<T> {
  chosen: T[];
  /** Quedan horarios libres después del último elegido: se puede ofrecer "ver otros". */
  hasMore: boolean;
}

/**
 * `slots`: ya ordenados por inicio y con una sola profesional por horario, como los deja
 * `pickFirstAvailable` (o los de una sola profesional).
 */
export function pickSpreadSlots<T extends { start: Date }>(
  slots: readonly T[],
  options: { count: number; minGapMinutes: number },
): SpreadSlots<T> {
  const { count, minGapMinutes } = options;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`Cantidad de opciones inválida: ${String(count)}`);
  }
  if (minGapMinutes < 0) {
    throw new RangeError(`Separación mínima inválida: ${String(minGapMinutes)} minutos`);
  }

  const chosen: T[] = [];
  for (const slot of slots) {
    if (chosen.length === count) break;
    const previous = chosen.at(-1);
    if (!previous || slot.start.getTime() - previous.start.getTime() >= minGapMinutes * MINUTE_MS) {
      chosen.push(slot);
    }
  }

  const last = chosen.at(-1);
  const hasMore = last !== undefined && slots.some((slot) => slot.start.getTime() > last.start.getTime());
  return { chosen, hasMore };
}
