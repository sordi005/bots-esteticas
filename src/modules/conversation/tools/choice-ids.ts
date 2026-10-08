/**
 * Ids de las opciones que las herramientas le ofrecen a la clienta (botones y listas, 5.3):
 *
 *   servicio:<servicio>
 *   horario:<servicio>:<profesional>:<inicio ISO en UTC>
 *   mas:<servicio>:<profesional o "-">:<inicio ISO del último horario ofrecido>
 *
 * Cuando la clienta elige, WhatsApp devuelve el id tal cual. Nunca se confía en él: se lee
 * con `parseChoiceId` y se vuelve a validar contra la base (`resolveChoice`).
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const INSTANT = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';

const SERVICE_ID = new RegExp(`^servicio:(${UUID})$`);
const SLOT_ID = new RegExp(`^horario:(${UUID}):(${UUID}):(${INSTANT})$`);
const MORE_ID = new RegExp(`^mas:(${UUID}):(${UUID}|-):(${INSTANT})$`);

export const choiceIds = {
  service: (serviceId: string) => `servicio:${serviceId}`,
  slot: (serviceId: string, professionalId: string, start: Date) =>
    `horario:${serviceId}:${professionalId}:${start.toISOString()}`,
  more: (serviceId: string, professionalId: string | null, after: Date) =>
    `mas:${serviceId}:${professionalId ?? '-'}:${after.toISOString()}`,
};

export type ParsedChoiceId =
  | { kind: 'service'; serviceId: string }
  | { kind: 'slot'; serviceId: string; professionalId: string; start: Date }
  | { kind: 'more'; serviceId: string; professionalId: string | null; after: Date };

/** Una fecha con la forma exacta de `toISOString()`, o null si no existe en el calendario. */
function parseInstant(text: string): Date | null {
  const instant = new Date(text);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === text ? instant : null;
}

export function parseChoiceId(id: string): ParsedChoiceId | null {
  const service = SERVICE_ID.exec(id);
  if (service?.[1]) return { kind: 'service', serviceId: service[1] };

  const slot = SLOT_ID.exec(id);
  if (slot?.[1] && slot[2] && slot[3]) {
    const start = parseInstant(slot[3]);
    return start ? { kind: 'slot', serviceId: slot[1], professionalId: slot[2], start } : null;
  }

  const more = MORE_ID.exec(id);
  if (more?.[1] && more[2] && more[3]) {
    const after = parseInstant(more[3]);
    return after
      ? { kind: 'more', serviceId: more[1], professionalId: more[2] === '-' ? null : more[2], after }
      : null;
  }

  return null;
}
