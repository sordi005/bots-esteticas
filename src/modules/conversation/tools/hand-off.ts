import { z } from 'zod';
import { handOff, HANDOFF_SUMMARY_MAX_LENGTH, type HandoffReason } from '../handoff.js';
import { isFillerSummary } from '../handoff-reasons.js';
import type { AgentTool } from './tool.js';

/** Los motivos que ve el modelo (en español) y el motivo que guarda la base (en inglés), sección 4.8. */
const STORED_REASONS = {
  pedido_de_la_clienta: 'customer_request',
  queja: 'complaint',
  tema_sensible: 'sensitive_topic',
  imagen: 'unsupported_media',
  consulta_previa: 'requires_consultation',
  fuera_de_catalogo: 'off_catalog',
  excepcion: 'policy_exception',
  no_entiende: 'not_understood',
} as const satisfies Record<string, HandoffReason>;

const REASONS = Object.keys(STORED_REASONS) as [keyof typeof STORED_REASONS, ...(keyof typeof STORED_REASONS)[]];

const input = z
  .object({
    motivo: z
      .enum(REASONS)
      .describe(
        'Por qué se deriva: pedido_de_la_clienta (pide hablar con una persona), queja (reclamo o enojo), ' +
          'tema_sensible (salud, alergias, embarazo, contraindicaciones), imagen (mandó una imagen), ' +
          'consulta_previa (servicio que requiere consulta previa), fuera_de_catalogo (servicio o dato que ' +
          'no está cargado y ella aceptó o insistió en que la vea una persona), excepcion (devolución, ' +
          'cancelación fuera de plazo u otra excepción), no_entiende (no entendés qué pide después de dos intentos).',
      ),
    resumen: z
      .string()
      .trim()
      .min(1)
      // El código recorta lo que pase de 200 caracteres: acá solo se frena lo desmedido.
      .max(HANDOFF_SUMMARY_MAX_LENGTH * 5)
      .describe(
        'Una sola línea para la dueña, de por lo menos 3 palabras y hasta 200 caracteres, con qué necesita la ' +
          'clienta de verdad (nada de relleno ni de pruebas). ' +
          'Con tema_sensible NO incluyas ningún dato de salud: escribí solo "consulta sensible".',
      ),
  })
  // Con tema_sensible el código guarda un resumen fijo (regla 9): no hace falta exigir el del modelo.
  .refine(({ motivo, resumen }) => motivo === 'tema_sensible' || !isFillerSummary(resumen), {
    path: ['resumen'],
    message:
      'El resumen no dice qué necesita la clienta: escribí en una línea, con por lo menos 3 palabras, qué necesita. ' +
      'Si no hay algo real para contarle a una persona, no derives y contestale a la clienta.',
  });

/**
 * `derivar_a_persona(motivo, resumen)` (6.4, 4.8): registra la derivación y pausa el asistente en
 * esta conversación. La conversación sale del contexto del servidor, nunca del modelo (regla 2).
 * Devuelve cuándo le va a responder una persona, escrito por el código.
 */
export const handOffTool: AgentTool<z.infer<typeof input>> = {
  name: 'derivar_a_persona',
  description:
    'Deriva la conversación a una persona del equipo: registra la derivación, avisa a la dueña y ' +
    'pausa al asistente en este chat. Usala solo cuando una de las reglas de derivación lo pide, con un ' +
    'resumen real de lo que necesita la clienta. Nunca la llames para probar, por las dudas ni con un ' +
    'resumen de relleno: deja al asistente callado en este chat. Devuelve ' +
    '"cuando", el texto que completa «te va a responder por acá …»: usalo tal cual para decirle a la ' +
    'clienta cuándo le responde una persona, sin prometer nada más. Después de derivar no sigas ' +
    'atendiendo el pedido.',
  input,
  async run({ motivo, resumen }, ctx) {
    const { when } = await handOff(ctx.db, {
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      reason: STORED_REASONS[motivo],
      summary: resumen,
      now: ctx.now,
    });

    return {
      content: {
        derivada: true,
        cuando: when,
        mensaje: `La conversación quedó derivada a una persona del equipo, que le va a responder por este chat ${when}.`,
      },
      options: [],
      handedOff: true,
    };
  },
};
