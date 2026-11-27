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

/** Un mensaje que la dueña mandó desde su app de WhatsApp Business (coexistencia, 8.1). */
export interface EchoEvent {
  kind: 'echo';
  phoneNumberId: string;
  /** wa_id de la clienta a la que le escribió la dueña. */
  to: string;
  messageId: string;
  timestamp: Date;
  /** text, image, video, document… y también edit o revoke (editó o borró un mensaje). */
  type: string;
  message: Record<string, unknown>;
}

export type WebhookEvent = InboundMessageEvent | MessageStatusEvent | EchoEvent;

/**
 * Un cambio de la cuenta de WhatsApp Business (`account_update`, H14): por ejemplo, el número se
 * desconectó de la coexistencia (PARTNER_REMOVED). Solo se alerta (10.3): no se guarda nada.
 */
export interface AccountUpdateEvent {
  kind: 'account_update';
  /** La cuenta de WhatsApp Business: identifica al negocio (8.1). */
  wabaId: string;
  event: string;
}

/** Una plantilla cambió de estado en Meta (`message_template_status_update`, H14). */
export interface TemplateStatusEvent {
  kind: 'template_status';
  wabaId: string;
  /** APPROVED, REJECTED, PAUSED, DISABLED, FLAGGED… */
  event: string;
  templateId: string;
  templateName: string;
  language: string;
  /** El motivo que da Meta (`NONE` si no hay). */
  reason: string | null;
}

export type AccountChange = AccountUpdateEvent | TemplateStatusEvent;

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

/** Sin `to` (la clienta solo tiene nombre de usuario) no se sabe de qué conversación es: se ignora. */
const echoSchema = z.looseObject({
  to: z.string().min(1),
  id: z.string().min(1),
  timestamp: unixSeconds,
  type: z.string().min(1),
});

const echoValueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp'),
  metadata: z.looseObject({ phone_number_id: z.string().min(1) }),
  // Cada eco se valida por separado: uno que no se entiende no tira los demás.
  message_echoes: z.array(z.unknown()),
});

// Formatos de developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference (H14).
const accountUpdateSchema = z.looseObject({
  event: z.string().min(1),
  waba_info: z.looseObject({ waba_id: z.string().min(1) }).optional(),
});

const templateStatusSchema = z.looseObject({
  event: z.string().min(1),
  // En el ejemplo oficial llega como número.
  message_template_id: z.union([z.number(), z.string().min(1)]),
  message_template_name: z.string().min(1),
  message_template_language: z.string().min(1),
  reason: z.string().nullish(),
});

const envelopeSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      // La cuenta de WhatsApp Business.
      id: z.string().optional(),
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })),
    }),
  ),
});

const fromUnixSeconds = (seconds: string) => new Date(Number(seconds) * 1000);

/** Un cambio de la cuenta, si el campo es uno de los que se alertan (H14). */
function accountChange(field: string, value: unknown, entryId: string | undefined): AccountChange | null {
  if (field === 'account_update') {
    const update = accountUpdateSchema.safeParse(value);
    // PARTNER_REMOVED trae la cuenta desconectada en waba_info; en el ejemplo oficial no es la de la entrada.
    const wabaId = update.success ? (update.data.waba_info?.waba_id ?? entryId) : undefined;
    return update.success && wabaId ? { kind: 'account_update', wabaId, event: update.data.event } : null;
  }
  if (field === 'message_template_status_update') {
    const status = templateStatusSchema.safeParse(value);
    if (!status.success || !entryId) return null;
    return {
      kind: 'template_status',
      wabaId: entryId,
      event: status.data.event,
      templateId: String(status.data.message_template_id),
      templateName: status.data.message_template_name,
      language: status.data.message_template_language,
      reason: status.data.reason ?? null,
    };
  }
  return null;
}

const ACCOUNT_FIELDS: readonly string[] = ['account_update', 'message_template_status_update'];

export function parseWebhook(body: unknown): { events: WebhookEvent[]; accountChanges: AccountChange[]; ignored: number } {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return { events: [], accountChanges: [], ignored: 1 };

  const events: WebhookEvent[] = [];
  const accountChanges: AccountChange[] = [];
  let ignored = 0;

  const changes = envelope.data.entry.flatMap((entry) => entry.changes.map((change) => ({ ...change, entryId: entry.id })));
  for (const change of changes) {
    if (ACCOUNT_FIELDS.includes(change.field)) {
      const parsed = accountChange(change.field, change.value, change.entryId);
      if (parsed) accountChanges.push(parsed);
      else ignored += 1;
      continue;
    }

    if (change.field === 'smb_message_echoes') {
      const value = echoValueSchema.safeParse(change.value);
      if (!value.success) {
        ignored += 1;
        continue;
      }
      for (const raw of value.data.message_echoes) {
        const echo = echoSchema.safeParse(raw);
        if (!echo.success) {
          ignored += 1;
          continue;
        }
        events.push({
          kind: 'echo',
          phoneNumberId: value.data.metadata.phone_number_id,
          to: echo.data.to,
          messageId: echo.data.id,
          timestamp: fromUnixSeconds(echo.data.timestamp),
          type: echo.data.type,
          message: echo.data,
        });
      }
      continue;
    }

    // Los demás campos (calidad del número, historial…) no se procesan.
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

  return { events, accountChanges, ignored };
}

const textMessage = z.object({ text: z.object({ body: z.string() }) });
const reply = z.object({ id: z.string(), title: z.string() });
const interactiveMessage = z.object({
  interactive: z.object({ button_reply: reply.optional(), list_reply: reply.optional() }),
});
/** El botón de una plantilla (8.1): llega como tipo `button`, con el dato que se fijó al enviar. */
const templateButton = z.object({ button: z.object({ payload: z.string().min(1), text: z.string() }) });
const captionedImage = z.object({ image: z.object({ caption: z.string() }) });
const imageWithId = z.object({ image: z.object({ id: z.string().min(1) }) });

/** El id de la imagen de un mensaje, o null si no es una imagen. Es lo que se guarda como comprobante (4.5). */
export function inboundImageId(message: Record<string, unknown>): string | null {
  const image = imageWithId.safeParse(message);
  return image.success ? image.data.image.id : null;
}

/**
 * Lo que dijo la clienta, como lo necesita el asistente. Una respuesta a botones o listas (también
 * el botón de una plantilla) trae el `replyId` de la opción elegida: se procesa sin pasar por la IA
 * (sección 5.3).
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

  const button = templateButton.safeParse(message);
  if (button.success) return { text: button.data.button.text, replyId: button.data.button.payload };

  const image = captionedImage.safeParse(message);
  return { text: image.success ? image.data.image.caption : null, replyId: null };
}
