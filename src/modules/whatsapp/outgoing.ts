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

const hasUniqueIds = (items: { id: string }[]) => new Set(items.map((item) => item.id)).size === items.length;

export const outgoingMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    body: z.string().min(1).max(4096),
    previewUrl: z.boolean().optional(),
  }),
  z
    .object({
      type: z.literal('buttons'),
      body: z.string().min(1).max(1024),
      footer: z.string().min(1).max(60).optional(),
      buttons: z.array(replyButton).min(1).max(3),
    })
    .refine((message) => hasUniqueIds(message.buttons), 'Los botones necesitan ids distintos'),
  z
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
    ),
]);

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
  }
}
