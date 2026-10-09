import type { Config } from './shared/config.js';

/**
 * Cuándo el worker procesa conversaciones. Se decide acá, y no en `main.ts`, para poder probarlo.
 *
 * - En producción no, hasta H8: sin derivación a una persona no se pueden cumplir las reglas de 4.8.
 * - En desarrollo hacen falta la clave de cifrado (para leer el token de WhatsApp del negocio) y la
 *   clave de la API de Claude.
 */
export type ConversationMode =
  | { kind: 'disabled'; reason: 'production' | 'missing_credentials_key' | 'missing_anthropic_key' }
  | { kind: 'agent'; credentialsKey: Buffer; anthropicApiKey: string };

export function chooseConversationMode(
  config: Pick<Config, 'nodeEnv' | 'credentialsKey' | 'anthropicApiKey'>,
): ConversationMode {
  if (config.nodeEnv === 'production') return { kind: 'disabled', reason: 'production' };
  if (!config.credentialsKey) return { kind: 'disabled', reason: 'missing_credentials_key' };
  if (!config.anthropicApiKey) return { kind: 'disabled', reason: 'missing_anthropic_key' };
  return { kind: 'agent', credentialsKey: config.credentialsKey, anthropicApiKey: config.anthropicApiKey };
}
