import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { z } from 'zod';

/**
 * Contrato de las herramientas del agente (6.4). Es neutral: no conoce el SDK del modelo.
 * El ciclo del agente las expone al modelo (nombre, descripción y el esquema de la entrada) y
 * ejecuta las que el modelo pide con `runTool`.
 *
 * "La IA elige, el código decide" (regla 2): el negocio, la clienta y la hora actual vienen
 * SOLO del contexto del servidor. Nunca son parte de la entrada que escribe el modelo.
 */
export interface ToolContext {
  db: NodePgDatabase;
  tenantId: string;
  customerId: string;
  /** La hora actual, inyectada (regla 5). */
  now: Date;
  /** Zona horaria del negocio: se usa solo para escribir fechas y horas. */
  timeZone: string;
  /** Se cancela si el ciclo del agente se corta (por ejemplo, por tiempo). */
  signal: AbortSignal;
}

/**
 * Algo que la clienta puede elegir con un botón o una fila de lista. Solo se pueden ofrecer los
 * ids que devolvió una herramienta en la misma vuelta (6.4).
 */
export interface OfferableOption {
  /** Se lo devuelve WhatsApp cuando la clienta elige: ver `choice-ids.ts`. */
  id: string;
  /** Hasta 24 caracteres (fila de lista); las herramientas lo dejan en 20 para que sirva de botón. */
  title: string;
  /** Hasta 72 caracteres (fila de lista). */
  description?: string;
}

/** Máximos de WhatsApp (outgoing.ts): título de botón 20, de fila 24; descripción de fila 72. */
export const MAX_OPTION_TITLE_LENGTH = 20;
export const MAX_OPTION_DESCRIPTION_LENGTH = 72;
/** Una lista tiene como máximo 10 filas en total. */
export const MAX_LIST_ROWS = 10;

export interface ToolResult {
  /** Lo que lee el modelo: JSON con los textos de precios y fechas ya escritos por el código. */
  content: Record<string, unknown>;
  /** Lo que el modelo puede ofrecer como botones o lista. */
  options: OfferableOption[];
  /** El modelo pidió algo inválido (no encontrado, fuera de rango…): que lo corrija o lo explique. */
  isError?: boolean;
}

export interface AgentTool<Input> {
  /** Lo que ve el modelo: en español (6.4). */
  name: string;
  description: string;
  /** Valida la entrada del modelo. */
  input: z.ZodType<Input>;
  run(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Ejecuta una herramienta con lo que escribió el modelo. Si la entrada no valida, la
 * herramienta no corre y el modelo recibe el error para que la corrija. Un fallo de la
 * herramienta misma (la base no responde) no se disfraza: se propaga.
 */
export async function runTool(
  tool: AgentTool<unknown>,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) {
    return {
      content: {
        error: 'Entrada inválida',
        detalles: parsed.error.issues.map((issue) => {
          const field = issue.path.map(String).join('.');
          return field === '' ? issue.message : `${field}: ${issue.message}`;
        }),
      },
      options: [],
      isError: true,
    };
  }
  return tool.run(parsed.data, ctx);
}
