import { afterAll, describe, expect, it } from 'vitest';
import { pendingInboundMessages } from '../../src/cli/echo-pending.js';
import { recordWebhookEvents } from '../../src/modules/conversation/inbox.js';
import { parseWebhook } from '../../src/modules/whatsapp/webhook-payload.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture } from './support/fixtures.js';
import { connectWhatsApp, textMessageWebhook } from './support/whatsapp.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

async function receive(phoneNumberId: string, messageId: string, text: string) {
  const { events } = parseWebhook(
    JSON.parse(textMessageWebhook({ phoneNumberId, from: '5492614000001', messageId, text })),
  );
  await recordWebhookEvents(db, events);
}

describe('pendingInboundMessages: lo que el eco todavía no contestó', () => {
  it('después de leer un mensaje, con su cursor ya no lo vuelve a traer', async () => {
    // Postgres guarda microsegundos y un Date de JS solo milisegundos: si el cursor
    // perdiera precisión, el mismo mensaje volvería en cada vuelta (pasó en la prueba real).
    const { tenantId } = await createTenantFixture(db);
    const phoneNumberId = await connectWhatsApp(db, tenantId);
    const start = new Date(Date.now() - 60_000).toISOString();
    await receive(phoneNumberId, 'wamid.eco-1', 'hola');

    const first = await pendingInboundMessages(db, { tenantId, after: start });
    expect(first.map((message) => message.content)).toEqual([expect.objectContaining({ text: { body: 'hola' } })]);

    const again = await pendingInboundMessages(db, { tenantId, after: first[0]?.cursor ?? start });
    expect(again).toEqual([]);
  });

  it('trae en orden lo que llegó después del cursor, y solo del negocio pedido', async () => {
    const tenant = await createTenantFixture(db);
    const other = await createTenantFixture(db);
    const phoneNumberId = await connectWhatsApp(db, tenant.tenantId);
    const otherPhoneNumberId = await connectWhatsApp(db, other.tenantId);
    const start = new Date(Date.now() - 60_000).toISOString();
    await receive(phoneNumberId, 'wamid.eco-a', 'primero');
    await receive(otherPhoneNumberId, 'wamid.eco-otro', 'de otro negocio');
    await receive(phoneNumberId, 'wamid.eco-b', 'segundo');

    const pending = await pendingInboundMessages(db, { tenantId: tenant.tenantId, after: start });

    expect(pending.map((message) => message.content)).toEqual([
      expect.objectContaining({ text: { body: 'primero' } }),
      expect.objectContaining({ text: { body: 'segundo' } }),
    ]);
    const [, second] = pending;
    expect(await pendingInboundMessages(db, { tenantId: tenant.tenantId, after: second?.cursor ?? start })).toEqual(
      [],
    );
  });
});
