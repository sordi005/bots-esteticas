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

const sendResponse = z.object({ messages: z.array(z.object({ id: z.string().min(1) })).min(1) });
const errorResponse = z.object({
  error: z.object({ message: z.string(), code: z.number().optional() }),
});

export function createWhatsAppClient(options: {
  graphApiVersion: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}): WhatsAppClient {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? 'https://graph.facebook.com';

  return {
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

      if (!response.ok) {
        const error = errorResponse.safeParse(body);
        throw new WhatsAppApiError(
          error.success
            ? `Meta rechazó el mensaje: ${error.data.error.message}`
            : `Meta respondió ${String(response.status)}`,
          response.status,
          error.success ? (error.data.error.code ?? null) : null,
        );
      }

      const sent = sendResponse.safeParse(body);
      const [first] = sent.success ? sent.data.messages : [];
      if (!first) {
        throw new WhatsAppApiError('Meta no devolvió el id del mensaje enviado', response.status, null);
      }
      return { messageId: first.id };
    },
  };
}
