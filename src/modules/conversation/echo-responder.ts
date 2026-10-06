import type { OutgoingMessage } from '../whatsapp/outgoing.js';
import { inboundContent } from '../whatsapp/webhook-payload.js';
import type { ReceivedMessage, Responder } from './processing.js';

/**
 * SOLO desarrollo, hasta que exista el agente (H7): contesta repitiendo lo que recibió.
 * Sirve para probar con el número de prueba de Meta que se reciben y se envían textos,
 * botones y listas, y que los mensajes seguidos se contestan una sola vez (5.2).
 */
export const echoResponder: Responder = (turn) => Promise.resolve(echoReply(turn.messages));

/** Largo máximo del texto de un mensaje de WhatsApp. */
const MAX_TEXT_LENGTH = 4_096;

export function echoReply(messages: ReceivedMessage[]): OutgoingMessage {
  const last = messages.at(-1);
  const { text, replyId } = last ? inboundContent(last.content) : { text: null, replyId: null };

  if (replyId && text) {
    return { type: 'text', body: `Elegiste: ${text} (${replyId})` };
  }

  const command = text?.trim().toLowerCase();
  if (command === 'botones') {
    return {
      type: 'buttons',
      body: '¿Confirmás tu turno del viernes 3 a las 15:30?',
      footer: 'Prueba del asistente',
      buttons: [
        { id: 'confirm', title: 'Confirmo' },
        { id: 'reschedule', title: 'Reprogramar' },
        { id: 'cancel', title: 'Cancelar' },
      ],
    };
  }
  if (command === 'lista') {
    return {
      type: 'list',
      body: 'Para el viernes tengo estos horarios:',
      buttonLabel: 'Ver horarios',
      sections: [
        {
          title: 'Viernes 3',
          rows: [
            { id: 'slot-1000', title: '10:00', description: 'Con Mica' },
            { id: 'slot-1530', title: '15:30', description: 'Con Mica' },
            { id: 'slot-1700', title: '17:00', description: 'Con Sofi' },
          ],
        },
      ],
    };
  }

  let body: string;
  if (messages.length === 1 && last) {
    body = text ? `Eco: ${text}` : `Recibí un mensaje de tipo ${last.type}`;
  } else {
    const parts = messages.map((message) => inboundContent(message.content).text ?? `[${message.type}]`);
    body = `Eco de ${String(messages.length)} mensajes: ${parts.join(' / ')}`;
  }
  return { type: 'text', body: body.slice(0, MAX_TEXT_LENGTH) };
}
