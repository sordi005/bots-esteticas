import { instantToLocal } from '../../../shared/time-zone.js';
import { formatLocalDateTime, formatLocalSlot } from '../format.js';
import { choiceIds } from '../tools/choice-ids.js';
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
  /** El nombre para el turno (4.9). El de perfil de WhatsApp no cuenta: crear_reserva lo exige. */
  bookingName: string | null;
  preferredProfessionalName: string | null;
  /**
   * Cuándo le responde una persona si el modelo deriva ("en este horario", "el viernes 9/10 a las
   * 9:00", "lo antes posible"), calculado por el código (4.8). Va acá y no en el prompt del sistema,
   * que tiene que ser idéntico entre vueltas.
   */
  humanReplyWhen: string;
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
    case 'horario': {
      const slotId = choiceIds.slot(choice.servicioId, choice.profesionalId, new Date(choice.inicio));
      return `Eligió el horario ${choice.texto} con ${choice.profesionalNombre} para ${choice.servicioNombre} (${String(choice.duracionMinutos)} min), horario_id=${slotId}; ${choice.sigueLibre ? 'sigue libre' : 'ya no está libre'}.`;
    }
    case 'ver_mas': {
      const professional = choice.profesionalId ? `, profesional_id=${choice.profesionalId}` : '';
      return `Pidió ver otros horarios, después de ${formatLocalSlot(new Date(choice.despuesDe), timeZone)}: consultá la disponibilidad con servicio_id=${choice.servicioId}${professional}, despues_de=${choice.despuesDe}.`;
    }
    case 'turno':
    case 'cancelar': {
      const turn = `${choice.texto} (${choice.servicioNombre} con ${choice.profesionalNombre}, ${choice.estado}), turno_id=${choiceIds.appointment(choice.turnoId)}`;
      const inactive = choice.ocupaHorario ? '' : ` Ojo: ese turno ya no está activo (${choice.estado}).`;
      if (choice.tipo === 'cancelar') {
        return `Confirmó que quiere cancelar el turno del ${turn}: llamá a cancelar_turno con confirmada=true.${inactive}`;
      }
      return (
        `Eligió su turno del ${turn}: ` +
        `seguí con lo que venía pidiendo (cancelar o reprogramar ese turno; para reprogramar, consultá la disponibilidad con ese turno_id).${inactive}`
      );
    }
    case 'reprogramar': {
      // Elegir el horario nuevo ya es la confirmación (principio 5): no se le pide otra.
      const slotId = choiceIds.reschedule(choice.turnoId, new Date(choice.inicio));
      const appointmentId = choiceIds.appointment(choice.turnoId);
      const inactive = choice.ocupaHorario ? '' : ` Ojo: ese turno ya no está activo (${choice.estado}).`;
      const next = choice.sigueLibre
        ? 'sigue libre. Elegirlo ya es la confirmación: llamá a reprogramar_turno con ese horario_id.'
        : `ya no está libre: consultá de nuevo la disponibilidad con turno_id=${appointmentId} y ofrecele otros horarios.`;
      return `Eligió el horario ${choice.texto} para pasar su turno del ${choice.turnoTexto} (${choice.servicioNombre} con ${choice.profesionalNombre}), horario_id=${slotId}; ${next}${inactive}`;
    }
    case 'ver_mas_reprogramar': {
      const inactive = choice.ocupaHorario ? '' : ' Ojo: ese turno ya no está activo.';
      return `Pidió ver otros horarios para pasar su turno del ${choice.turnoTexto}, después de ${formatLocalSlot(new Date(choice.despuesDe), timeZone)}: consultá la disponibilidad con turno_id=${choiceIds.appointment(choice.turnoId)}, despues_de=${choice.despuesDe}.${inactive}`;
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
    input.bookingName
      ? `- Nombre para el turno: ${input.bookingName} (ya está cargado: no lo pidas).`
      : '- Nombre para el turno: no está cargado: pedíselo antes de reservar.',
  ];
  if (input.preferredProfessionalName) {
    lines.push(`- Profesional preferida: ${input.preferredProfessionalName}.`);
  }
  lines.push(
    `- Si derivás a una persona, le responde ${input.humanReplyWhen}: escribilo tal cual en tu mensaje («te va a responder por acá ${input.humanReplyWhen}»), sin prometer otra hora.`,
  );
  if (input.choices.length > 0) {
    lines.push(
      '- Elecciones de la clienta en este mensaje:',
      ...input.choices.map((choice, index) => `  ${String(index + 1)}. ${describeChoice(choice, timeZone)}`),
    );
  }
  return lines.join('\n');
}
