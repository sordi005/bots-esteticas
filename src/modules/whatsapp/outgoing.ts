import { z } from 'zod';

/**
 * Mensajes salientes (sección 5.1: elecciones con botones o listas). Los límites son los de
 * la documentación de Meta y se validan ANTES de enviar: un mensaje inválido nunca llega a
 * la API, y el error dice qué está mal.
 */
const replyButton = z.object({
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(20),
});

const listRow = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(24),
  description: z.string().min(1).max(72).optional(),
});

const listSection = z.object({
  title: z.string().min(1).max(24).optional(),
  rows: z.array(listRow).min(1),
});

/** Una imagen de encabezado, por su id de Meta: el aviso de un comprobante a la dueña (8.2). */
const imageHeader = z.object({ type: z.literal('image'), imageId: z.string().min(1) });

const hasUniqueIds = (items: { id: string }[]) => new Set(items.map((item) => item.id)).size === items.length;

/**
 * El valor de una variable de plantilla (8.1): Meta rechaza saltos de línea, tabulaciones y más de
 * cuatro espacios seguidos. El código los limpia antes (`templateMessage`); acá solo se verifica.
 */
const templateParam = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/[\n\r\t]| {4,}/.test(value), 'Una variable de plantilla no lleva saltos de línea ni tabulaciones');

const textMessage = z.object({
  type: z.literal('text'),
  body: z.string().min(1).max(4096),
  previewUrl: z.boolean().optional(),
});

const buttonsMessage = z
  .object({
    type: z.literal('buttons'),
    header: imageHeader.optional(),
    body: z.string().min(1).max(1024),
    footer: z.string().min(1).max(60).optional(),
    buttons: z.array(replyButton).min(1).max(3),
  })
  .refine((message) => hasUniqueIds(message.buttons), 'Los botones necesitan ids distintos');

const listMessage = z
  .object({
    type: z.literal('list'),
    header: z.string().min(1).max(60).optional(),
    body: z.string().min(1).max(4096),
    footer: z.string().min(1).max(60).optional(),
    buttonLabel: z.string().min(1).max(20),
    sections: z.array(listSection).min(1).max(10),
  })
  .refine(
    (message) => message.sections.flatMap((section) => section.rows).length <= 10,
    'Una lista tiene como máximo 10 filas en total',
  )
  .refine(
    (message) => message.sections.length === 1 || message.sections.every((section) => section.title),
    'Con más de una sección, cada sección necesita título',
  )
  .refine(
    (message) => hasUniqueIds(message.sections.flatMap((section) => section.rows)),
    'Las filas necesitan ids distintos',
  );

/** Lo que arma el agente o un aviso: solo entra dentro de la ventana de 24 horas (8.2). */
export const freeFormMessageSchema = z.discriminatedUnion('type', [textMessage, buttonsMessage, listMessage]);

/** Una plantilla aprobada por Meta (8.1, H10): el texto vive en Meta; acá van su nombre y las variables. */
export const templateMessageSchema = z.object({
  type: z.literal('template'),
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().min(2),
  header: imageHeader.optional(),
  /** Las variables con nombre del cuerpo (`{{servicio}}`). */
  params: z.record(z.string().regex(/^[a-z_]+$/), templateParam),
  /** El dato de cada botón de respuesta rápida, en orden: vuelve en el webhook al tocarlo. */
  buttonPayloads: z.array(z.string().min(1).max(256)).max(10).optional(),
});

export const outgoingMessageSchema = z.discriminatedUnion('type', [
  textMessage,
  buttonsMessage,
  listMessage,
  templateMessageSchema,
]);

export type FreeFormMessage = z.input<typeof freeFormMessageSchema>;
export type TemplateMessage = z.input<typeof templateMessageSchema>;
export type OutgoingMessage = z.input<typeof outgoingMessageSchema>;

/** Cuerpo del POST a /{phone_number_id}/messages. */
export function toGraphPayload(to: string, message: OutgoingMessage): Record<string, unknown> {
  const valid = outgoingMessageSchema.parse(message);
  const envelope = { messaging_product: 'whatsapp', recipient_type: 'individual', to };

  switch (valid.type) {
    case 'text':
      return { ...envelope, type: 'text', text: { body: valid.body, preview_url: valid.previewUrl ?? false } };
    case 'buttons':
      return {
        ...envelope,
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(valid.header ? { header: { type: 'image', image: { id: valid.header.imageId } } } : {}),
          body: { text: valid.body },
          ...(valid.footer ? { footer: { text: valid.footer } } : {}),
          action: {
            buttons: valid.buttons.map(({ id, title }) => ({ type: 'reply', reply: { id, title } })),
          },
        },
      };
    case 'list':
      return {
        ...envelope,
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(valid.header ? { header: { type: 'text', text: valid.header } } : {}),
          body: { text: valid.body },
          ...(valid.footer ? { footer: { text: valid.footer } } : {}),
          action: { button: valid.buttonLabel, sections: valid.sections },
        },
      };
    case 'template': {
      const params = Object.entries(valid.params);
      const components = [
        ...(valid.header ? [{ type: 'header', parameters: [{ type: 'image', image: { id: valid.header.imageId } }] }] : []),
        ...(params.length > 0
          ? [
              {
                type: 'body',
                parameters: params.map(([name, text]) => ({ type: 'text', parameter_name: name, text })),
              },
            ]
          : []),
        ...(valid.buttonPayloads ?? []).map((payload, index) => ({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(index),
          parameters: [{ type: 'payload', payload }],
        })),
      ];
      return { ...envelope, type: 'template', template: { name: valid.name, language: { code: valid.language }, components } };
    }
  }
}
