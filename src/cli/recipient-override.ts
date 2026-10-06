import type { WhatsAppClient } from '../modules/whatsapp/client.js';

/**
 * SOLO para probar con el número de prueba de Meta: manda todo a `to`, sin importar
 * a quién iba dirigido el mensaje.
 *
 * Existe por Argentina: WhatsApp identifica al celular como 549 + área + número, pero
 * la lista de permitidos del número de prueba lo guarda como 54 + área + 15 + número y
 * compara el texto tal cual (error 131030). En producción no hay lista y no hace falta.
 */
export function withRecipientOverride(client: WhatsAppClient, to: string | undefined): WhatsAppClient {
  if (!to) return client;
  return { sendMessage: (input) => client.sendMessage({ ...input, to }) };
}
