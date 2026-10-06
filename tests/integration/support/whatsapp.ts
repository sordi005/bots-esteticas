import { createHmac, randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenants } from '../../../src/modules/tenants/schema.js';

export const APP_SECRET = 'secreto-de-la-app-de-prueba';
export const VERIFY_TOKEN = 'token-de-verificacion-de-prueba';

/** Firma como lo hace Meta: HMAC-SHA256 del cuerpo crudo con el App Secret. */
export function sign(rawBody: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Le asigna un número de WhatsApp al negocio y devuelve su phone_number_id. */
export async function connectWhatsApp(db: NodePgDatabase, tenantId: string): Promise<string> {
  const phoneNumberId = String(randomInt(100_000_000_000, 999_999_999_999));
  await db.update(tenants).set({ whatsappPhoneNumberId: phoneNumberId }).where(eq(tenants.id, tenantId));
  return phoneNumberId;
}

function envelope(phoneNumberId: string, value: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5492615550000', phone_number_id: phoneNumberId },
              ...value,
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

/** Un mensaje de texto con la forma exacta de los ejemplos de Meta (tests/contracts/whatsapp). */
export function textMessageWebhook(input: {
  phoneNumberId: string;
  from: string;
  messageId: string;
  text: string;
  profileName?: string;
  timestamp?: number;
}): string {
  return JSON.stringify(
    envelope(input.phoneNumberId, {
      contacts: [{ profile: { name: input.profileName ?? 'Caro' }, wa_id: input.from }],
      messages: [
        {
          from: input.from,
          id: input.messageId,
          timestamp: String(input.timestamp ?? 1_790_000_000),
          type: 'text',
          text: { body: input.text },
        },
      ],
    }),
  );
}

export function statusWebhook(input: {
  phoneNumberId: string;
  messageId: string;
  status: string;
  category?: string;
}): string {
  return JSON.stringify(
    envelope(input.phoneNumberId, {
      statuses: [
        {
          id: input.messageId,
          status: input.status,
          timestamp: '1790000100',
          recipient_id: '5492614000001',
          ...(input.category
            ? { pricing: { billable: true, pricing_model: 'PMP', type: 'regular', category: input.category } }
            : {}),
        },
      ],
    }),
  );
}
