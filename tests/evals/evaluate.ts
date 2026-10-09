import type { AgentOutcome } from '../../src/modules/conversation/agent/outcome.js';
import type { handoffReason } from '../../src/modules/conversation/schema.js';
import type { ResolvedChoice } from '../../src/modules/conversation/tools/choices.js';
import type { AppointmentStatus } from '../../src/modules/scheduling/appointment-state-machine.js';

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

/** Un turno de la base después de la vuelta: el de la clienta del caso o uno de los que preparó el caso. */
export interface EvalAppointmentState {
  /** La clave con la que el caso preparó el turno (`EvalAppointmentSetup.clave`), o null si lo creó el agente. */
  clave: string | null;
  /** De quién es: la clienta del caso, u otra que preparó el caso. */
  de: 'clienta' | 'otra';
  servicio: string;
  profesional: string;
  /** Inicio en hora local del negocio, "AAAA-MM-DD HH:MM". */
  inicio: string;
  estado: AppointmentStatus;
}

/** Lo que quedó en la base después de la vuelta, para los chequeos con `verifica`. */
export interface EvalState {
  turnos: EvalAppointmentState[];
  derivaciones: { motivo: (typeof handoffReason.enumValues)[number]; resumen: string }[];
  /** La conversación quedó pausada (derivada a una persona). */
  pausada: boolean;
  /** El nombre que quedó cargado en la ficha de la clienta. */
  nombreClienta: string | null;
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
  estado: EvalState;
}

/** Qué opción toca la clienta. Se arma con los ids de verdad (`choice-ids.ts`) al correr el caso. */
export type EvalChoice =
  /** Un horario del catálogo: servicio y profesional por nombre, inicio en hora local "AAAA-MM-DD HH:MM". */
  | { tipo: 'horario'; servicio: string; profesional: string; inicio: string }
  /** Uno de sus turnos (por la `clave` con la que lo preparó el caso). */
  | { tipo: 'turno'; turno: string }
  /** El botón «Sí, cancelar» de uno de sus turnos. */
  | { tipo: 'cancelar'; turno: string };

/** Un mensaje de la clienta: texto, una opción tocada (con el título del botón) o una imagen (con texto opcional). */
export type EvalInbound =
  | string
  | { eleccion: EvalChoice; titulo: string }
  | { imagen: string | null };

/** Un mensaje anterior a la vuelta: de la clienta o del asistente (texto, con los títulos de sus botones si ofreció). */
export type EvalHistoryEntry = { clienta: EvalInbound } | { asistente: string; botones?: string[] };

/** Un turno que existe antes de la vuelta. Se crea con `booking.ts`, como en producción. */
export interface EvalAppointmentSetup {
  /** Para referirse a él desde `eleccion` y desde los chequeos del estado. */
  clave?: string;
  /** Nombres tal cual figuran en el seed. */
  servicio: string;
  profesional: string;
  /** Inicio en hora local del negocio, "AAAA-MM-DD HH:MM". */
  inicio: string;
  /** El turno es de otra clienta con ese nombre (si no, es de la clienta del caso). */
  otraClienta?: string;
  /** La seña ya está paga: el turno queda confirmado. */
  senaAprobada?: boolean;
  /**
   * Los inicios anteriores del turno, del primero al último: se reservó en el primero y se
   * reprogramó a cada uno de los siguientes hasta `inicio`. Cada uno es una reprogramación usada.
   */
  reprogramadoDesde?: string[];
}

/** El estado que arma el corredor antes de la vuelta. */
export interface EvalSetup {
  /** El nombre que ya tiene cargado la clienta (si no, la ficha no tiene nombre). */
  nombre?: string;
  turnos?: EvalAppointmentSetup[];
  /** Mensajes anteriores, ya procesados, de los minutos previos a la hora fija. */
  historial?: EvalHistoryEntry[];
}

export interface EvalCase {
  nombre: string;
  /** Lo que escribe la clienta, en la misma vuelta (en orden). */
  mensajes: EvalInbound[];
  preparar?: EvalSetup;
  /** Mueve la hora de la vuelta (por defecto, la hora fija de `clock.ts`): "AAAA-MM-DD HH:MM" en hora local. */
  ahora?: string;
  espera: {
    /** Tienen que haberse llamado (todas, en cualquier orden; puede haber otras). */
    herramientas?: string[];
    /** No se llamó ninguna de estas. */
    noLlama?: string[];
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
  for (const tool of espera.noLlama ?? []) {
    if (result.herramientas.includes(tool)) motivos.push(`No debía llamar a ${tool} y llamó: ${called}`);
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
