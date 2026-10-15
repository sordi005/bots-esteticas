import type { EvalChoice, EvalInbound } from './evaluate.js';

/**
 * Un mensaje de la clienta, con la forma con la que lo guarda el webhook (el mensaje tal como lo
 * mandó Meta, `messages.content`). Puro: el id de una opción lo arma el corredor con la base y
 * se lo pasa por `resolveChoiceId`.
 */
export interface InboundMessage {
  /** Tipo según WhatsApp (`messages.type`). */
  type: string;
  content: Record<string, unknown>;
}

/** Los ids de medio de una imagen de prueba: nunca se descargan, el asistente solo ve el marcador. */
const IMAGE_SAMPLE = { mime_type: 'image/jpeg', sha256: 'eval-sha256', id: 'eval-media-id' };

export function buildInboundMessage(
  inbound: EvalInbound,
  resolveChoiceId: (choice: EvalChoice) => string,
): InboundMessage {
  if (typeof inbound === 'string') {
    return { type: 'text', content: { type: 'text', text: { body: inbound } } };
  }

  if ('imagen' in inbound) {
    const image = inbound.imagen === null ? IMAGE_SAMPLE : { caption: inbound.imagen, ...IMAGE_SAMPLE };
    return { type: 'image', content: { type: 'image', image } };
  }

  const reply = { id: resolveChoiceId(inbound.eleccion), title: inbound.titulo };
  // «Sí, cancelar» llega de un botón; los horarios y los turnos, de una lista (5.3).
  const interactive =
    inbound.eleccion.tipo === 'cancelar'
      ? { type: 'button_reply', button_reply: reply }
      : { type: 'list_reply', list_reply: reply };
  return { type: 'interactive', content: { type: 'interactive', interactive } };
}
