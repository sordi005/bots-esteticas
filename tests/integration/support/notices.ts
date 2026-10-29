import type { OutgoingMessage } from '../../../src/modules/whatsapp/outgoing.js';

/** El texto de un aviso con mensaje libre. Uno con plantilla no tiene cuerpo propio: falla el test. */
export function noticeBody(message: OutgoingMessage | undefined): string | undefined {
  if (!message) return undefined;
  if (message.type === 'template') throw new Error(`El aviso es la plantilla ${message.name}: no tiene cuerpo`);
  return message.body;
}
