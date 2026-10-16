import { outgoingMessageSchema } from '../../whatsapp/outgoing.js';
import { inboundContent, inboundImageId } from '../../whatsapp/webhook-payload.js';

/**
 * Los mensajes guardados en `messages`, como texto para el modelo (5.3). Los que no son texto
 * llegan como marcadores entre corchetes, que el prompt del sistema explica.
 */

/** Lo que ve el modelo cuando la clienta toca un botón o una fila: el detalle va en el contexto de la vuelta. */
export const CHOICE_MARKER = '[La clienta tocó una opción de un botón o una lista]';

const UNREADABLE = '[Mensaje que no se puede leer]';

/** Una imagen que el código registró como el comprobante de la seña (4.5): no es una imagen para derivar. */
export const RECEIPT_MARKER = '[Comprobante de la seña]';

const MARKERS: Record<string, string> = {
  audio: '[Audio]',
  sticker: '[Sticker]',
  location: '[Ubicación]',
  contacts: '[Contacto]',
  video: '[Video]',
  document: '[Documento]',
};

export interface InboundDescription {
  text: string;
  /** El id de la opción elegida: se resuelve y se vuelve a validar en el código, no lo interpreta el modelo. */
  replyId: string | null;
  /** El título del botón o de la fila. Solo para el historial. */
  replyTitle: string | null;
}

/**
 * Lo que dijo la clienta en un mensaje entrante (`type` y `content` tal como se guardaron).
 * `receiptMediaIds`: las imágenes que el código ya registró como comprobantes.
 */
export function describeInbound(
  type: string,
  content: Record<string, unknown>,
  receiptMediaIds: ReadonlySet<string> = new Set(),
): InboundDescription {
  const { text, replyId } = inboundContent(content);
  if (replyId) return { text: CHOICE_MARKER, replyId, replyTitle: text };

  let described: string;
  if (type === 'text') {
    described = text ?? UNREADABLE;
  } else if (type === 'image') {
    const imageId = inboundImageId(content);
    const marker = imageId && receiptMediaIds.has(imageId) ? RECEIPT_MARKER : '[Imagen]';
    described = text ? `${marker} «${text}»` : marker;
  } else {
    described = MARKERS[type] ?? UNREADABLE;
  }
  return { text: described, replyId: null, replyTitle: null };
}

/**
 * Lo que dijo el asistente en un mensaje saliente: el cuerpo y los títulos de las opciones que
 * ofreció. Null si el contenido guardado no es un mensaje que conozcamos.
 */
export function outgoingToText(content: Record<string, unknown>): string | null {
  const message = outgoingMessageSchema.safeParse(content);
  if (!message.success) return null;
  const { data } = message;

  switch (data.type) {
    case 'text':
      return data.body;
    case 'buttons':
      return `${data.body}\n[Botones: ${data.buttons.map((button) => button.title).join(' | ')}]`;
    case 'list': {
      const titles = data.sections.flatMap((section) => section.rows.map((row) => row.title));
      return `${data.body}\n[Opciones: ${titles.join(' | ')}]`;
    }
  }
}
