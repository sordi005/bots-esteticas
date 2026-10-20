import { z } from 'zod';
import { toGraphPayload, type OutgoingMessage } from './outgoing.js';

/**
 * Cliente de la API de WhatsApp Cloud (sección 8.1). Recibe `fetch` por parámetro para
 * poder probarlo sin red. El token de acceso nunca aparece en los errores ni en los logs.
 */
export class WhatsAppApiError extends Error {
  override name = 'WhatsAppApiError';
  readonly status: number;
  /** Código de error de Meta, por ejemplo 131030 (número no permitido). */
  readonly code: number | null;

  constructor(message: string, status: number, code: number | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Lo que se guarda cifrado en `tenant_credentials` (tipo `whatsapp`) para cada negocio. */
export const whatsAppCredentialSchema = z.object({ accessToken: z.string().min(1) });

export interface SendMessageInput {
  phoneNumberId: string;
  accessToken: string;
  /** Número de la clienta en formato E.164, con "+". */
  to: string;
  message: OutgoingMessage;
}

export interface WhatsAppClient {
  sendMessage(input: SendMessageInput): Promise<{ messageId: string }>;
}

export interface DownloadedMedia {
  data: Uint8Array;
  mimeType: string;
}

/**
 * Bajar una imagen recibida y subirla a otro número (8.2): el aviso de un comprobante sale por el
 * número de avisos, y Meta no documenta que el id de una imagen recibida sirva para enviarla.
 */
export interface WhatsAppMediaClient {
  downloadMedia(input: { mediaId: string; accessToken: string }): Promise<DownloadedMedia>;
  uploadMedia(input: {
    phoneNumberId: string;
    accessToken: string;
    data: Uint8Array;
    mimeType: string;
  }): Promise<{ mediaId: string }>;
}

const sendResponse = z.object({ messages: z.array(z.object({ id: z.string().min(1) })).min(1) });
const mediaResponse = z.object({ url: z.url(), mime_type: z.string().min(1) });
const uploadResponse = z.object({ id: z.string().min(1) });
const errorResponse = z.object({
  error: z.object({ message: z.string(), code: z.number().optional() }),
});

/** El error de Meta con su código, sin el token (que nunca está en la respuesta). */
function apiError(action: string, status: number, body: unknown): WhatsAppApiError {
  const error = errorResponse.safeParse(body);
  return new WhatsAppApiError(
    error.success ? `Meta rechazó ${action}: ${error.data.error.message}` : `Meta respondió ${String(status)}`,
    status,
    error.success ? (error.data.error.code ?? null) : null,
  );
}

export function createWhatsAppClient(options: {
  graphApiVersion: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}): WhatsAppClient & WhatsAppMediaClient {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? 'https://graph.facebook.com';
  const graphUrl = (path: string) => `${baseUrl}/${options.graphApiVersion}/${path}`;
  const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

  return {
    // Formatos de https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
    async downloadMedia({ mediaId, accessToken }) {
      const lookup = await request(graphUrl(encodeURIComponent(mediaId)), { headers: bearer(accessToken) });
      const lookupBody: unknown = await lookup.json().catch(() => null);
      if (!lookup.ok) throw apiError('la imagen', lookup.status, lookupBody);
      const media = mediaResponse.safeParse(lookupBody);
      if (!media.success) throw new WhatsAppApiError('Meta no devolvió la URL de la imagen', lookup.status, null);

      // La URL vence a los 5 minutos y también pide el token.
      const file = await request(media.data.url, { headers: bearer(accessToken) });
      if (!file.ok) throw new WhatsAppApiError(`No se pudo bajar la imagen: ${String(file.status)}`, file.status, null);
      return { data: new Uint8Array(await file.arrayBuffer()), mimeType: media.data.mime_type };
    },

    async uploadMedia({ phoneNumberId, accessToken, data, mimeType }) {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mimeType);
      form.append('file', new Blob([data], { type: mimeType }), 'comprobante');

      const response = await request(graphUrl(`${encodeURIComponent(phoneNumberId)}/media`), {
        method: 'POST',
        headers: bearer(accessToken),
        body: form,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw apiError('la imagen', response.status, body);
      const uploaded = uploadResponse.safeParse(body);
      if (!uploaded.success) throw new WhatsAppApiError('Meta no devolvió el id de la imagen subida', response.status, null);
      return { mediaId: uploaded.data.id };
    },

    async sendMessage({ phoneNumberId, accessToken, to, message }) {
      // Valida los límites de Meta antes de cualquier llamada.
      const payload = toGraphPayload(to, message);

      const response = await request(
        `${baseUrl}/${options.graphApiVersion}/${encodeURIComponent(phoneNumberId)}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) throw apiError('el mensaje', response.status, body);

      const sent = sendResponse.safeParse(body);
      const [first] = sent.success ? sent.data.messages : [];
      if (!first) {
        throw new WhatsAppApiError('Meta no devolvió el id del mensaje enviado', response.status, null);
      }
      return { messageId: first.id };
    },
  };
}
