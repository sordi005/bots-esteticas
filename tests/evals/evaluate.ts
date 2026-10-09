import type { AgentOutcome } from '../../src/modules/conversation/agent/outcome.js';
import type { ResolvedChoice } from '../../src/modules/conversation/tools/choices.js';

/**
 * Evaluar un caso (sección 11.4): módulo puro, sin base ni red. Recibe lo que el agente contestó
 * (`EvalResult`) y lo compara con lo que espera el caso (`EvalCase`). Los tests unitarios lo
 * cubren y corren en `pnpm check`; las evaluaciones contra la API real, no.
 */

/** Una opción (botón o fila de lista) del mensaje que se le habría enviado a la clienta. */
export interface EvalOption {
  id: string;
  titulo: string;
  descripcion: string | null;
  /**
   * La opción vuelta a resolver contra la base a la hora fija de la evaluación (como lo hace el
   * worker cuando la clienta la toca). Así los chequeos con código quedan síncronos y puros.
   */
  resuelta?: ResolvedChoice;
}

/** Lo que dejó una vuelta del agente. */
export interface EvalResult {
  /** El cuerpo del mensaje que se le habría enviado a la clienta. */
  texto: string;
  tipo: 'text' | 'buttons' | 'list';
  opciones: EvalOption[];
  /** Los nombres de las herramientas que se ejecutaron, en orden (`agent_runs.tool_calls`). */
  herramientas: string[];
  outcome: AgentOutcome;
  tokens: { entrada: number; salida: number; cacheLectura: number; cacheEscritura: number };
  latenciaMs: number;
}

export interface EvalCase {
  nombre: string;
  /** Mensajes de texto de la clienta, en la misma vuelta. */
  mensajes: string[];
  espera: {
    /** Tienen que haberse llamado (todas, en cualquier orden; puede haber otras). */
    herramientas?: string[];
    /** No se llamó ninguna. */
    sinHerramientas?: boolean;
    /** Aparecen en la respuesta (texto, y títulos y descripciones de las opciones). */
    menciona?: string[];
    /** No aparecen en la respuesta. */
    noMenciona?: string[];
    /** Chequeo extra con código: devuelve el motivo del fallo, o null si está bien. */
    verifica?: (resultado: EvalResult) => string | null;
  };
}

export interface Evaluation {
  ok: boolean;
  /** Por qué falló, uno por cada condición incumplida. Vacío si pasó. */
  motivos: string[];
}

/**
 * Para comparar textos: minúsculas y sin tildes (descompone en NFD y saca las marcas). No toca
 * dígitos ni signos: "18.000" y "18000" son cosas distintas, y "$" cuenta.
 */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Todo lo que lee la clienta: el texto más los títulos y descripciones de las opciones. */
function visibleText(result: EvalResult): string {
  const parts = [result.texto];
  for (const option of result.opciones) {
    parts.push(option.titulo);
    if (option.descripcion) parts.push(option.descripcion);
  }
  return normalizeText(parts.join('\n'));
}

/** Resultados con los que la clienta recibió una respuesta del agente (aunque sea una a medias). */
const ANSWERED: AgentOutcome[] = ['replied', 'tool_limit'];

export function evaluateCase(evalCase: EvalCase, result: EvalResult): Evaluation {
  const { espera } = evalCase;
  const motivos: string[] = [];

  // Una frase de disculpa fija o ninguna respuesta no es un acierto, aunque no mencione nada prohibido.
  if (!ANSWERED.includes(result.outcome)) {
    motivos.push(`El agente no pudo contestar (outcome: ${result.outcome})`);
  }

  const called = result.herramientas.length > 0 ? result.herramientas.join(', ') : 'ninguna';
  for (const tool of espera.herramientas ?? []) {
    if (!result.herramientas.includes(tool)) motivos.push(`No llamó a ${tool} (llamó: ${called})`);
  }
  if (espera.sinHerramientas && result.herramientas.length > 0) {
    motivos.push(`No debía llamar herramientas y llamó: ${called}`);
  }

  const seen = visibleText(result);
  for (const expected of espera.menciona ?? []) {
    if (!seen.includes(normalizeText(expected))) motivos.push(`No menciona "${expected}"`);
  }
  for (const forbidden of espera.noMenciona ?? []) {
    if (seen.includes(normalizeText(forbidden))) motivos.push(`Menciona "${forbidden}" y no debería`);
  }

  const extra = espera.verifica?.(result);
  if (extra) motivos.push(extra);

  return { ok: motivos.length === 0, motivos };
}
