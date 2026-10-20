import { z } from 'zod';
import type { ownerReplyAction } from './schema.js';

/**
 * Ids de los botones de los avisos a la dueña: `aviso:<id del aviso>:<acción>` (6.5, 8.2). El id
 * del aviso alcanza para encontrarlo; el negocio sale de quién lo tocó, nunca del id (regla 1).
 */

export type OwnerReplyAction = (typeof ownerReplyAction.enumValues)[number];

const PREFIX = 'aviso';

/** La acción como va en el id: corta y en español, como los demás ids de opciones. */
const ACTION_CODES = {
  deposit_received: 'recibida',
  deposit_not_received: 'no_llego',
  handoff_attended: 'atendida',
} as const satisfies Record<OwnerReplyAction, string>;

const ACTIONS_BY_CODE = new Map<string, OwnerReplyAction>(
  Object.entries(ACTION_CODES).map(([action, code]) => [code, action as OwnerReplyAction]),
);

const uuid = z.uuid();

export function ownerButtonId(notificationId: string, action: OwnerReplyAction): string {
  return `${PREFIX}:${notificationId}:${ACTION_CODES[action]}`;
}

/** El aviso y la acción de un botón, o null si no es un botón de un aviso. */
export function parseOwnerButtonId(id: string): { notificationId: string; action: OwnerReplyAction } | null {
  const [prefix, notificationId, code, ...rest] = id.split(':');
  if (prefix !== PREFIX || rest.length > 0 || !uuid.safeParse(notificationId).success) return null;
  const action = code === undefined ? undefined : ACTIONS_BY_CODE.get(code);
  if (!action || notificationId === undefined) return null;
  return { notificationId, action };
}
