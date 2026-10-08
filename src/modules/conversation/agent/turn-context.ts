import { instantToLocal } from '../../../shared/time-zone.js';
import { formatLocalDateTime, formatLocalSlot } from '../format.js';
import type { ResolvedChoice } from '../tools/choices.js';

/**
 * El contexto de la vuelta: lo que cambia en cada respuesta y por eso va FUERA del prompt del
 * sistema (8.5), para que el proveedor pueda reutilizar la caché del prompt. Lo escribe el
 * servidor: la fecha y la hora salen de la hora inyectada, no del modelo.
 */
export interface TurnContextInput {
  now: Date;
  timeZone: string;
  /** El asistente no le escribió a la clienta en las últimas 24 horas (5.1). */
  isNewConversation: boolean;
  customerName: string | null;
  preferredProfessionalName: string | null;
  /** Lo que la clienta tocó en botones o listas, ya resuelto y vuelto a validar (5.3). */
  choices: ResolvedChoice[];
}

/** Cómo se le cuenta al modelo una elección ya resuelta: nunca ve el título del botón. */
export function describeChoice(choice: ResolvedChoice, timeZone: string): string {
  switch (choice.tipo) {
    case 'servicio':
      return [
        `Eligió el servicio «${choice.nombre}» (servicio_id=${choice.servicioId}; precio: ${choice.precioTexto}; duración: ${choice.duracionTexto}).`,
        choice.requiereConsultaPrevia ? ' Requiere consulta previa: no se agenda por acá.' : '',
      ].join('');
    case 'horario':
      return `Eligió el horario ${choice.texto} con ${choice.profesionalNombre} para ${choice.servicioNombre} (${String(choice.duracionMinutos)} min); ${choice.sigueLibre ? 'sigue libre' : 'ya no está libre'}.`;
    case 'ver_mas': {
      const professional = choice.profesionalId ? `, profesional_id=${choice.profesionalId}` : '';
      return `Pidió ver otros horarios, después de ${formatLocalSlot(new Date(choice.despuesDe), timeZone)}: consultá la disponibilidad con servicio_id=${choice.servicioId}${professional}, despues_de=${choice.despuesDe}.`;
    }
    case 'desconocido':
      return 'Eligió una opción que ya no es válida (puede ser de una conversación vieja).';
  }
}

export function buildTurnContext(input: TurnContextInput): string {
  const { now, timeZone } = input;
  const lines = [
    'Contexto del sistema (no lo escribió la clienta):',
    `- Fecha y hora actual: ${formatLocalDateTime(now, timeZone)} (${timeZone}).`,
    `- Hoy, para consultar_disponibilidad: ${instantToLocal(now, timeZone).date}.`,
    `- Conversación nueva: ${input.isNewConversation ? 'sí, presentate' : 'no'}.`,
    `- Nombre de la clienta: ${input.customerName ?? 'no se conoce'}.`,
  ];
  if (input.preferredProfessionalName) {
    lines.push(`- Profesional preferida: ${input.preferredProfessionalName}.`);
  }
  if (input.choices.length > 0) {
    lines.push(
      '- Elecciones de la clienta en este mensaje:',
      ...input.choices.map((choice, index) => `  ${String(index + 1)}. ${describeChoice(choice, timeZone)}`),
    );
  }
  return lines.join('\n');
}
