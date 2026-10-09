import { expect } from 'vitest';
import type { ToolResult } from '../../../src/modules/conversation/tools/tool.js';

/** Todos los valores de un campo `opcionId`, en cualquier parte del contenido. */
function collectOptionIds(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectOptionIds(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'opcionId' && typeof child === 'string') found.push(child);
      else collectOptionIds(child, found);
    }
  }
  return found;
}

/**
 * Lo que el modelo no ve, no lo puede ofrecer: cada opción que devuelve una herramienta tiene que
 * figurar en su contenido como `opcionId` (el modelo solo lee el contenido; las opciones las usa
 * el código para armar los botones). Si falta, el modelo ofrece otro id y el botón se descarta.
 */
export function expectOptionsShownToModel(result: Pick<ToolResult, 'content' | 'options'>): void {
  const shown = collectOptionIds(result.content);
  expect(result.options.length).toBeGreaterThan(0);
  expect(shown.slice().sort()).toEqual(result.options.map((option) => option.id).sort());
}
