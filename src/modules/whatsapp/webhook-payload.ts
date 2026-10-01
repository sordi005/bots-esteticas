import { z } from 'zod';

/**
 * Lectura de los webhooks de WhatsApp Cloud API (sección 6.5). Valida con Zod solo lo que
 * el sistema usa y conserva el mensaje original completo para guardarlo. Lo que no
 * reconoce no rompe nada: se cuenta como ignorado y se loguea.
 */
export interface InboundMessageEvent {
  kind: 'message';
  /** Identifica al negocio (sección 6.5, paso 2). */
  phoneNumberId: string;
  /** wa_id de la clienta: su número sin el "+". */
  from: string;
  profileName: string | null;
  messageId: string;
  timestamp: Date;
  type: string;
  /** El mensaje tal como lo mandó Meta. */
  message: Record<string, unknown>;
}

export interface MessageStatusEvent {
  kind: 'status';
  phoneNumberId: string;
  /** Id del mensaje enviado al que se refiere el estado. */
  messageId: string;
  recipientId: string;
  status: string;
  timestamp: Date;
  /** Categoría de precio de Meta (service, utility, marketing…), si vino. */
  pricingCategory: string | null;
  errors: { code: number; title: string }[];
}

export type WebhookEvent = InboundMessageEvent | MessageStatusEvent;

const unixSeconds = z.string().regex(/^\d+$/);

const messageSchema = z.looseObject({
  from: z.string().min(1),
  id: z.string().min(1),
  timestamp: unixSeconds,
  type: z.string().min(1),
});

const statusSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1),
  timestamp: unixSeconds,
  recipient_id: z.string().min(1),
  pricing: z.looseObject({ category: z.string() }).optional(),
  errors: z.array(z.looseObject({ code: z.number(), title: z.string() })).optional(),
});

const valueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp'),
  metadata: z.looseObject({ phone_number_id: z.string().min(1) }),
  contacts: z
    .array(z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string() }).optional() }))
    .optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(statusSchema).optional(),
});

const envelopeSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({ changes: z.array(z.object({ field: z.string(), value: z.unknown() })) }),
  ),
});

const fromUnixSeconds = (seconds: string) => new Date(Number(seconds) * 1000);

export function parseWebhook(body: unknown): { events: WebhookEvent[]; ignored: number } {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return { events: [], ignored: 1 };

  const events: WebhookEvent[] = [];
  let ignored = 0;

  for (const change of envelope.data.entry.flatMap((entry) => entry.changes)) {
    // Otros campos (ecos de la coexistencia, cambios de la cuenta) llegan en hitos futuros.
    const value = change.field === 'messages' ? valueSchema.safeParse(change.value) : null;
    if (!value?.success) {
      ignored += 1;
      continue;
    }

    const { metadata, contacts = [], messages = [], statuses = [] } = value.data;
    for (const message of messages) {
      events.push({
        kind: 'message',
        phoneNumberId: metadata.phone_number_id,
        from: message.from,
        profileName: contacts.find((contact) => contact.wa_id === message.from)?.profile?.name ?? null,
        messageId: message.id,
        timestamp: fromUnixSeconds(message.timestamp),
        type: message.type,
        message,
      });
    }
    for (const status of statuses) {
      events.push({
        kind: 'status',
        phoneNumberId: metadata.phone_number_id,
        messageId: status.id,
        recipientId: status.recipient_id,
        status: status.status,
        timestamp: fromUnixSeconds(status.timestamp),
        pricingCategory: status.pricing?.category ?? null,
        errors: (status.errors ?? []).map(({ code, title }) => ({ code, title })),
      });
    }
  }

  return { events, ignored };
}

const textMessage = z.object({ text: z.object({ body: z.string() }) });
const reply = z.object({ id: z.string(), title: z.string() });
const interactiveMessage = z.object({
  interactive: z.object({ button_reply: reply.optional(), list_reply: reply.optional() }),
});
const captionedImage = z.object({ image: z.object({ caption: z.string() }) });

/**
 * Lo que dijo la clienta, como lo necesita el asistente. Una respuesta a botones o listas
 * trae el `replyId` de la opción elegida: se procesa sin pasar por la IA (sección 5.3).
 */
export function inboundContent(message: Record<string, unknown>): {
  text: string | null;
  replyId: string | null;
} {
  const text = textMessage.safeParse(message);
  if (text.success) return { text: text.data.text.body, replyId: null };

  const interactive = interactiveMessage.safeParse(message);
  const choice = interactive.success
    ? (interactive.data.interactive.button_reply ?? interactive.data.interactive.list_reply)
    : undefined;
  if (choice) return { text: choice.title, replyId: choice.id };

  const image = captionedImage.safeParse(message);
  return { text: image.success ? image.data.image.caption : null, replyId: null };
}
