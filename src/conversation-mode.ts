import type { Config } from './shared/config.js';

/**
 * Cuándo el worker procesa conversaciones. Se decide acá, y no en `main.ts`, para poder probarlo.
 *
 * - Hacen falta la clave de cifrado (para leer el token de WhatsApp del negocio) y la clave de la
 *   API de Claude. En producción la configuración (`shared/config.ts`) ya exige las dos al arrancar;
 *   en desarrollo pueden faltar y el worker simplemente no contesta.
 * - Desde H8 producción también procesa conversaciones: ya existe la derivación a una persona (4.8).
 */
export type ConversationMode =
  | { kind: 'disabled'; reason: 'missing_credentials_key' | 'missing_anthropic_key' }
  | { kind: 'agent'; credentialsKey: Buffer; anthropicApiKey: string };

export function chooseConversationMode(
  config: Pick<Config, 'credentialsKey' | 'anthropicApiKey'>,
): ConversationMode {
  if (!config.credentialsKey) return { kind: 'disabled', reason: 'missing_credentials_key' };
  if (!config.anthropicApiKey) return { kind: 'disabled', reason: 'missing_anthropic_key' };
  return { kind: 'agent', credentialsKey: config.credentialsKey, anthropicApiKey: config.anthropicApiKey };
}
