import { z } from 'zod';
import { listVisibleServices } from '../../catalog/queries.js';
import { matchServices } from '../../catalog/service-search.js';
import { serviceContent, serviceOption } from './service-content.js';
import { MAX_LIST_ROWS, type AgentTool } from './tool.js';

const MAX_SEARCH_TEXT_LENGTH = 200;

const input = z.object({
  texto: z
    .string()
    .trim()
    .max(MAX_SEARCH_TEXT_LENGTH)
    .optional()
    .describe(
      'Lo que pide la clienta, tal como lo dijo (por ejemplo "semi" o "uñas esculpidas"). ' +
        'Si no se manda, devuelve todo el catálogo.',
    ),
});

/**
 * `buscar_servicios(texto?)` (6.4): los servicios del catálogo que coinciden con lo que pide la
 * clienta, con precio y duración. Solo los visibles, solo los de este negocio.
 */
export const searchServicesTool: AgentTool<z.infer<typeof input>> = {
  name: 'buscar_servicios',
  description:
    'Busca servicios del catálogo por nombre o apodo (sin importar tildes ni mayúsculas) y devuelve ' +
    'para cada uno su id, precio, precio en efectivo, si el precio es fijo o "desde", duración, si ' +
    'requiere consulta previa y qué profesionales lo hacen. Sin texto devuelve el catálogo completo. ' +
    'Usala para cualquier pregunta de precios, duración o para saber si se hace un servicio. ' +
    'Si no encuentra nada, el servicio no está en el catálogo: no inventes precios.',
  input,
  async run({ texto }, ctx) {
    const catalog = await listVisibleServices(ctx.db, ctx.tenantId);
    const found = texto ? matchServices(catalog, texto) : catalog;

    if (found.length === 0) {
      return {
        content: {
          coincidencias: [],
          mensaje: 'No está en el catálogo',
          serviciosDisponibles: catalog.map((service) => service.name),
        },
        options: [],
      };
    }

    // Una lista de WhatsApp tiene como máximo 10 filas: no se cuenta nada que no se pueda elegir.
    const shown = found.slice(0, MAX_LIST_ROWS);
    return {
      content: {
        coincidencias: shown.map(serviceContent),
        total: found.length,
        ...(found.length > shown.length ? { hayMas: true } : {}),
      },
      options: shown.map(serviceOption),
    };
  },
};
