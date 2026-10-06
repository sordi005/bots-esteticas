import type { OutgoingMessage } from '../modules/whatsapp/outgoing.js';
import { inboundContent } from '../modules/whatsapp/webhook-payload.js';

/**
 * Respuesta de la herramienta de eco de H5 a un mensaje recibido. Sirve para probar con el
 * número de prueba de Meta que se reciben y se envían textos, botones y listas.
 */
export function echoReply(message: Record<string, unknown>): OutgoingMessage {
  const { text, replyId } = inboundContent(message);

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
  if (text) {
    return { type: 'text', body: `Eco: ${text}` };
  }

  const type = typeof message.type === 'string' ? message.type : 'desconocido';
  return { type: 'text', body: `Recibí un mensaje de tipo ${type}` };
}
