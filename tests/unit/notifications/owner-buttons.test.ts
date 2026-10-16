import { describe, expect, it } from 'vitest';
import { ownerButtonId, parseOwnerButtonId } from '../../../src/modules/notifications/owner-buttons.js';

const NOTICE = '0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6';

describe('botones de los avisos a la dueña (6.5, 8.2)', () => {
  it.each([
    ['deposit_received', `aviso:${NOTICE}:recibida`],
    ['deposit_not_received', `aviso:${NOTICE}:no_llego`],
    ['handoff_attended', `aviso:${NOTICE}:atendida`],
  ] as const)('%s se escribe como %s y se vuelve a leer igual', (action, id) => {
    expect(ownerButtonId(NOTICE, action)).toBe(id);
    expect(parseOwnerButtonId(id)).toEqual({ notificationId: NOTICE, action });
  });

  it.each([
    ['un horario de la clienta', 'horario:a:b:2026-10-05T13:00:00.000Z'],
    ['una acción que no existe', `aviso:${NOTICE}:borrar`],
    ['un id de aviso que no es un uuid', 'aviso:123:recibida'],
    ['partes de más', `aviso:${NOTICE}:recibida:extra`],
    ['un texto cualquiera', 'Recibida'],
  ])('no es un botón de aviso: %s', (_case, id) => {
    expect(parseOwnerButtonId(id)).toBeNull();
  });
});
