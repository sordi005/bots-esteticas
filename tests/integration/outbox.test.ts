import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { sendWhatsAppMessage } from '../../src/modules/conversation/outbox.js';
import { messages } from '../../src/modules/conversation/schema.js';
import { saveCredential } from '../../src/modules/tenants/credentials.js';
import {
  WhatsAppApiError,
  type SendMessageInput,
  type WhatsAppClient,
} from '../../src/modules/whatsapp/client.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, FIXTURE_CUSTOMER_PHONE, single } from './support/fixtures.js';
import { connectWhatsApp } from './support/whatsapp.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const credentialsKey = randomBytes(32);
const NOW = new Date('2026-10-05T13:00:00.000Z');

afterAll(() => database.close());

function fakeClient(result: () => Promise<{ messageId: string }>) {
  const sent: SendMessageInput[] = [];
  const client: WhatsAppClient = {
    sendMessage: (input) => {
      sent.push(input);
      return result();
    },
  };
  return { client, sent };
}

async function readyTenant() {
  const fixture = await createTenantFixture(db);
  const phoneNumberId = await connectWhatsApp(db, fixture.tenantId);
  await saveCredential(db, credentialsKey, {
    tenantId: fixture.tenantId,
    kind: 'whatsapp',
    value: { accessToken: 'EAAG-token-del-negocio' },
  });
  return { ...fixture, phoneNumberId };
}

describe('sendWhatsAppMessage: enviar y registrar', () => {
  it('envía con el número y el token del negocio y guarda el mensaje saliente', async () => {
    const tenant = await readyTenant();
    const { client, sent } = fakeClient(() => Promise.resolve({ messageId: 'wamid.saliente-1' }));

    const result = await sendWhatsAppMessage(
      { db, client, credentialsKey, now: NOW },
      {
        tenantId: tenant.tenantId,
        customerId: tenant.customerId,
        message: { type: 'buttons', body: '¿Confirmás?', buttons: [{ id: 'confirm', title: 'Confirmo' }] },
      },
    );

    expect(result).toEqual({ ok: true, messageId: 'wamid.saliente-1' });
    expect(sent).toEqual([
      {
        phoneNumberId: tenant.phoneNumberId,
        accessToken: 'EAAG-token-del-negocio',
        to: FIXTURE_CUSTOMER_PHONE,
        message: { type: 'buttons', body: '¿Confirmás?', buttons: [{ id: 'confirm', title: 'Confirmo' }] },
      },
    ]);
    expect(
      single(await db.select().from(messages).where(eq(messages.whatsappMessageId, 'wamid.saliente-1'))),
    ).toMatchObject({
      tenantId: tenant.tenantId,
      conversationId: tenant.conversationId,
      direction: 'outbound',
      type: 'interactive',
      occurredAt: NOW,
      content: { type: 'buttons', body: '¿Confirmás?' },
    });
  });

  it('un negocio sin WhatsApp conectado no envía nada', async () => {
    const fixture = await createTenantFixture(db);
    const { client, sent } = fakeClient(() => Promise.resolve({ messageId: 'x' }));

    const result = await sendWhatsAppMessage(
      { db, client, credentialsKey, now: NOW },
      { tenantId: fixture.tenantId, customerId: fixture.customerId, message: { type: 'text', body: 'hola' } },
    );

    expect(result).toEqual({ ok: false, reason: 'not_connected' });
    expect(sent).toEqual([]);
  });

  it('no le escribe a una clienta de otro negocio (regla 1)', async () => {
    const tenant = await readyTenant();
    const other = await createTenantFixture(db);
    const { client, sent } = fakeClient(() => Promise.resolve({ messageId: 'x' }));

    const result = await sendWhatsAppMessage(
      { db, client, credentialsKey, now: NOW },
      { tenantId: tenant.tenantId, customerId: other.customerId, message: { type: 'text', body: 'hola' } },
    );

    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(sent).toEqual([]);
  });

  it('si Meta rechaza el envío, no se guarda un mensaje que nunca salió', async () => {
    const tenant = await readyTenant();
    const { client } = fakeClient(() =>
      Promise.reject(new WhatsAppApiError('Meta rechazó el mensaje: número no permitido', 400, 131030)),
    );

    await expect(
      sendWhatsAppMessage(
        { db, client, credentialsKey, now: NOW },
        { tenantId: tenant.tenantId, customerId: tenant.customerId, message: { type: 'text', body: 'hola' } },
      ),
    ).rejects.toThrow(WhatsAppApiError);

    expect(await db.select().from(messages).where(eq(messages.tenantId, tenant.tenantId))).toEqual([]);
  });
});
