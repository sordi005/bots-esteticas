import type { HandoffReason } from './handoff.js';

/**
 * Los motivos de derivación tal como los ve el modelo (en español, 4.8) y las reglas puras del
 * resumen. Es un módulo sin base ni infraestructura: el ciclo del agente lo importa para armar y
 * validar el campo `derivar` de la respuesta (6.4) sin conocer la base de datos.
 */

/**
 * Cada motivo que puede poner el modelo, con el motivo que guarda la base (en inglés) y la
 * descripción que lee el modelo. La lista es cerrada: es la de la sección 4.8.
 */
export const MODEL_HANDOFF_REASONS = {
  pedido_de_la_clienta: {
    reason: 'customer_request',
    description: 'la clienta pide hablar con una persona',
  },
  queja: {
    reason: 'complaint',
    description: 'reclamo, queja o enojo',
  },
  tema_sensible: {
    reason: 'sensitive_topic',
    description: 'cuenta algo de su salud, alergias, embarazo o contraindicaciones',
  },
  imagen: {
    reason: 'unsupported_media',
    description: 'mandó una imagen (no hay forma de leerla)',
  },
  consulta_previa: {
    reason: 'requires_consultation',
    description: 'quiere un servicio que requiere consulta previa',
  },
  fuera_de_catalogo: {
    reason: 'off_catalog',
    description:
      'pidió un servicio que no está en el catálogo o un dato que no está cargado, y aceptó o insistió en que la vea una persona',
  },
  excepcion: {
    reason: 'policy_exception',
    description: 'pide una devolución, cambiar de profesional o de servicio, u otra excepción',
  },
  no_entiende: {
    reason: 'not_understood',
    description: 'después de dos intentos, no entendés qué te pide',
  },
} as const satisfies Record<string, { reason: HandoffReason; description: string }>;

export type ModelHandoffReason = keyof typeof MODEL_HANDOFF_REASONS;

/**
 * Los motivos que usa solo el código: el modelo no los ve ni los puede elegir. `payment_issue`:
 * un problema con la seña que no resuelve el asistente (4.5, 4.8).
 */
export const CODE_ONLY_HANDOFF_REASONS = ['payment_issue'] as const satisfies readonly HandoffReason[];

export const MODEL_HANDOFF_REASON_NAMES = Object.keys(MODEL_HANDOFF_REASONS) as [
  ModelHandoffReason,
  ...ModelHandoffReason[],
];

/** [S] Un resumen real tiene por lo menos 3 palabras (4.8). */
export const HANDOFF_SUMMARY_MIN_WORDS = 3;

/** Palabras que delatan un resumen de relleno. */
const FILLER_WORDS = new Set(['placeholder', 'lorem', 'ipsum', 'prueba', 'test', 'ignorar']);

/**
 * ¿El resumen es relleno? Las evaluaciones mostraron al modelo emitiendo la derivación sin haberla
 * decidido, con resúmenes como «placeholder», «x» o «Ignorar». Una derivación pausa al asistente,
 * así que un resumen así no deriva: la respuesta no sirve y la clienta recibe el texto fijo (8.5).
 */
export function isFillerSummary(summary: string): boolean {
  const words = summary
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
  return words.length < HANDOFF_SUMMARY_MIN_WORDS || words.some((word) => FILLER_WORDS.has(word));
}
