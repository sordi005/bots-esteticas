import { z } from 'zod';
import { getBusinessInfo, getWeeklyHours, type BusinessInfoTopic } from '../../catalog/queries.js';
import { describeTeamHours } from '../weekly-hours.js';
import type { AgentTool } from './tool.js';

/** Los temas que ve el modelo (en español) y el tema que guarda la base (en inglés). */
const STORED_TOPICS = {
  direccion: 'address',
  estacionamiento: 'parking',
  medios_de_pago: 'payment_methods',
  promociones: 'promotions',
  politicas: 'policies',
  cuidados: 'aftercare',
} as const satisfies Record<string, BusinessInfoTopic>;

const TOPICS = [...(Object.keys(STORED_TOPICS) as (keyof typeof STORED_TOPICS)[]), 'horarios'] as const;

const input = z.object({
  tema: z.enum(TOPICS).describe('Sobre qué datos del negocio pregunta la clienta.'),
});

/**
 * `consultar_informacion(tema)` (6.4): datos que cargó la dueña. `horarios` no es un texto
 * cargado: se arma con el horario semanal de las profesionales activas. Un tema sin datos se
 * informa como "no cargado": el asistente no inventa (5.1, principio 3).
 */
export const businessInfoTool: AgentTool<z.infer<typeof input>> = {
  name: 'consultar_informacion',
  description:
    'Devuelve datos del negocio cargados por la dueña: dirección, estacionamiento, medios de pago, ' +
    'promociones, políticas (seña, cancelación), cuidados posteriores y horarios de atención. ' +
    'Si el tema no está cargado devuelve cargado=false: en ese caso decile a la clienta que no ' +
    'tenés ese dato y ofrecé que lo vea una persona. No completes con información propia.',
  input,
  async run({ tema }, ctx) {
    const text =
      tema === 'horarios'
        ? describeTeamHours(await getWeeklyHours(ctx.db, ctx.tenantId))
        : await getBusinessInfo(ctx.db, ctx.tenantId, STORED_TOPICS[tema]);

    return {
      content: text ? { tema, cargado: true, texto: text } : { tema, cargado: false },
      options: [],
    };
  },
};
