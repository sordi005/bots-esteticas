import { z } from 'zod';

/**
 * Si un número está en coexistencia (8.1, H13): la dueña sigue con su app de WhatsApp Business y el
 * sistema usa la Cloud API en el mismo número. Meta lo informa en el número de teléfono con
 * `GET /{phone-number-id}?fields=is_on_biz_app,platform_type`.
 *
 * - `coexistence`: las dos cosas. Llegan los ecos de lo que la dueña escribe desde la app.
 * - `api_only`: solo la API. No hay ecos, así que el asistente nunca se entera de que ella escribió.
 * - `not_connected`: el número no está registrado en la Cloud API.
 * - `unknown`: Meta respondió algo que no se entiende.
 */
export type CoexistenceStatus = 'coexistence' | 'api_only' | 'not_connected' | 'unknown';

export const COEXISTENCE_FIELDS = 'is_on_biz_app,platform_type';

const phoneNumberPlatform = z.object({
  is_on_biz_app: z.boolean(),
  platform_type: z.string(),
});

export function coexistenceStatus(body: unknown): CoexistenceStatus {
  const parsed = phoneNumberPlatform.safeParse(body);
  if (!parsed.success) return 'unknown';
  if (parsed.data.platform_type !== 'CLOUD_API') return 'not_connected';
  return parsed.data.is_on_biz_app ? 'coexistence' : 'api_only';
}
