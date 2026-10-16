import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { messages } from '../../src/modules/conversation/schema.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { enqueueNotification, sendNotification } from '../../src/modules/notifications/outbox.js';
import { notifications } from '../../src/modules/notifications/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { saveCredential } from '../../src/modules/tenants/credentials.js';
import { tenants } from '../../src/modules/tenants/schema.js';
import {
  WhatsAppApiError,
  type SendMessageInput,
  type WhatsAppClient,
  type WhatsAppMediaClient,
} from '../../src/modules/whatsapp/client.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, FIXTURE_CUSTOMER_PHONE, single } from './support/fixtures.js';
import { connectWhatsApp } from './support/whatsapp.js';

/**
 * Avisos (6.7, 8.2): se guardan con el cambio que los origina y los envía una tarea. A la dueña
 * van por el número de avisos (o el del negocio en la fase 0); a la clienta, por el del negocio.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const credentialsKey = randomBytes(32);
const NOW = new Date('2026-10-05T13:00:00.000Z');
const OWNER_PHONE = '+5492615550000';
const logger = pino({ level: 'silent' });

afterAll(() => database.close());

function fakeClient(options: { fail?: () => Error } = {}) {
  const sent: SendMessageInput[] = [];
  const downloads: { mediaId: string; accessToken: string }[] = [];
  const uploads: { phoneNumberId: string; accessToken: string; mimeType: string }[] = [];
  const client: WhatsAppClient & WhatsAppMediaClient = {
    sendMessage: (input) => {
      if (options.fail) return Promise.reject(options.fail());
      sent.push(input);
      return Promise.resolve({ messageId: `wamid.${randomUUID()}` });
    },
    downloadMedia: (input) => {
      downloads.push(input);
      return Promise.resolve({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' });
    },
    uploadMedia: ({ phoneNumberId, accessToken, mimeType }) => {
      uploads.push({ phoneNumberId, accessToken, mimeType });
      return Promise.resolve({ mediaId: 'media-subida' });
    },
  };
  return { client, sent, downloads, uploads };
}

async function readyTenant(options: { ownerPhone?: string | null } = {}) {
  const fixture = await createTenantFixture(db);
  const phoneNumberId = await connectWhatsApp(db, fixture.tenantId);
  await saveCredential(db, credentialsKey, {
    tenantId: fixture.tenantId,
    kind: 'whatsapp',
    value: { accessToken: 'EAAG-token-del-negocio' },
  });
  const ownerPhone = options.ownerPhone === undefined ? OWNER_PHONE : options.ownerPhone;
  await db.update(tenants).set({ ownerPhone }).where(eq(tenants.id, fixture.tenantId));
  return { ...fixture, phoneNumberId };
}

type Tenant = Awaited<ReturnType<typeof readyTenant>>;

function ownerNotice(tenant: Tenant) {
  return enqueueNotification(db, {
    tenantId: tenant.tenantId,
    recipient: 'owner',
    kind: 'appointment_cancelled',
    customerId: tenant.customerId,
    appointmentId: tenant.appointmentId,
    message: { type: 'text', body: 'Caro canceló su turno' },
    now: NOW,
  });
}

async function receiptNotice(tenant: Tenant) {
  const [deposit] = await db
    .insert(deposits)
    .values({
      tenantId: tenant.tenantId,
      appointmentId: tenant.appointmentId,
      amountCents: 540_000,
      method: 'transfer',
      status: 'in_review',
      receiptMediaId: 'media-del-negocio',
      expiresAt: NOW,
    })
    .returning({ id: deposits.id });
  return enqueueNotification(db, {
    tenantId: tenant.tenantId,
    recipient: 'owner',
    kind: 'deposit_receipt',
    customerId: tenant.customerId,
    appointmentId: tenant.appointmentId,
    depositId: deposit?.id ?? '',
    receiptMediaId: 'media-del-negocio',
    message: { type: 'buttons', body: '¿Llegó?', buttons: [{ id: 'si', title: 'Recibida' }] },
    now: NOW,
  });
}

function send(
  tenant: Tenant,
  notificationId: string,
  client: WhatsAppClient & WhatsAppMediaClient,
  notificationsNumber?: { phoneNumberId: string; accessToken: string },
) {
  return sendNotification(
    { db, logger, client, credentialsKey, now: () => NOW, ...(notificationsNumber ? { notificationsNumber } : {}) },
    { tenantId: tenant.tenantId, notificationId },
  );
}

async function notificationRow(id: string) {
  return single(await db.select().from(notifications).where(eq(notifications.id, id)));
}

describe('enqueueNotification: el aviso se guarda y se programa su envío', () => {
  it('queda pendiente, con la tarea de envío para ya', async () => {
    const tenant = await readyTenant();

    const id = await ownerNotice(tenant);

    expect(await notificationRow(id)).toMatchObject({ status: 'pending', kind: 'appointment_cancelled' });
    const job = single(
      await db
        .select()
        .from(scheduledJobs)
        .where(and(eq(scheduledJobs.tenantId, tenant.tenantId), eq(scheduledJobs.key, id))),
    );
    expect(job).toMatchObject({ kind: 'send_notification', status: 'pending', runAt: NOW, payload: { notificationId: id } });
  });

  it('dentro de una transacción que falla, no queda ni el aviso ni la tarea', async () => {
    const tenant = await readyTenant();
    let id = '';

    await expect(
      db.transaction(async (tx) => {
        id = await enqueueNotification(tx, {
          tenantId: tenant.tenantId,
          recipient: 'owner',
          kind: 'appointment_cancelled',
          customerId: tenant.customerId,
          message: { type: 'text', body: 'Caro canceló su turno' },
          now: NOW,
        });
        throw new Error('falló el cambio');
      }),
    ).rejects.toThrow('falló el cambio');

    expect(await db.select().from(notifications).where(eq(notifications.id, id))).toEqual([]);
    expect(await db.select().from(scheduledJobs).where(eq(scheduledJobs.key, id))).toEqual([]);
  });
});

describe('sendNotification: avisos a la dueña (8.2)', () => {
  it('sin número de avisos, sale del número del negocio hacia la dueña (fase 0) y queda enviado', async () => {
    const tenant = await readyTenant();
    const id = await ownerNotice(tenant);
    const { client, sent } = fakeClient();

    expect(await send(tenant, id, client)).toBe('sent');

    expect(sent).toEqual([
      {
        phoneNumberId: tenant.phoneNumberId,
        accessToken: 'EAAG-token-del-negocio',
        to: OWNER_PHONE,
        message: { type: 'text', body: 'Caro canceló su turno' },
      },
    ]);
    expect(await notificationRow(id)).toMatchObject({ status: 'sent', sentAt: NOW });
  });

  it('con número de avisos configurado, sale de ese número con su token', async () => {
    const tenant = await readyTenant();
    const id = await ownerNotice(tenant);
    const { client, sent } = fakeClient();

    await send(tenant, id, client, { phoneNumberId: '999000111', accessToken: 'EAAG-token-de-avisos' });

    expect(sent[0]).toMatchObject({ phoneNumberId: '999000111', accessToken: 'EAAG-token-de-avisos', to: OWNER_PHONE });
  });

  it('el comprobante se baja del número del negocio, se sube al que envía y va como encabezado', async () => {
    const tenant = await readyTenant();
    const id = await receiptNotice(tenant);
    const { client, sent, downloads, uploads } = fakeClient();

    await send(tenant, id, client, { phoneNumberId: '999000111', accessToken: 'EAAG-token-de-avisos' });

    expect(downloads).toEqual([{ mediaId: 'media-del-negocio', accessToken: 'EAAG-token-del-negocio' }]);
    expect(uploads).toEqual([{ phoneNumberId: '999000111', accessToken: 'EAAG-token-de-avisos', mimeType: 'image/jpeg' }]);
    expect(sent[0]?.message).toMatchObject({ type: 'buttons', header: { type: 'image', imageId: 'media-subida' } });
  });

  it('sin teléfono de la dueña no se envía: queda fallido con el motivo', async () => {
    const tenant = await readyTenant({ ownerPhone: null });
    const id = await ownerNotice(tenant);
    const { client, sent } = fakeClient();

    expect(await send(tenant, id, client)).toBe('failed');

    expect(sent).toEqual([]);
    expect(await notificationRow(id)).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/teléfono/) as unknown });
  });

  it('fuera de la ventana de 24 horas (131047) queda fallido sin reintentar: las plantillas llegan en H10', async () => {
    const tenant = await readyTenant();
    const id = await ownerNotice(tenant);
    const { client } = fakeClient({
      fail: () => new WhatsAppApiError('Meta rechazó el mensaje: Re-engagement message', 400, 131047),
    });

    expect(await send(tenant, id, client)).toBe('failed');

    expect(await notificationRow(id)).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/131047/) as unknown });
  });

  it('otro error de Meta sube, para que la tarea reintente, y el aviso queda pendiente', async () => {
    const tenant = await readyTenant();
    const id = await ownerNotice(tenant);
    const { client } = fakeClient({ fail: () => new WhatsAppApiError('Meta respondió 500', 500, null) });

    await expect(send(tenant, id, client)).rejects.toThrow('Meta respondió 500');

    expect((await notificationRow(id)).status).toBe('pending');
  });

  it('un aviso ya enviado no se vuelve a enviar (la tarea puede correr dos veces, regla 7)', async () => {
    const tenant = await readyTenant();
    const id = await ownerNotice(tenant);
    const first = fakeClient();
    await send(tenant, id, first.client);
    const second = fakeClient();

    expect(await send(tenant, id, second.client)).toBe('already_handled');

    expect(second.sent).toEqual([]);
  });

  it('no envía el aviso de otro negocio (regla 1)', async () => {
    const tenant = await readyTenant();
    const other = await readyTenant();
    const id = await ownerNotice(tenant);
    const { client, sent } = fakeClient();

    expect(await send(other, id, client)).toBe('not_found');

    expect(sent).toEqual([]);
  });
});

describe('sendNotification: avisos a la clienta (4.5)', () => {
  it('salen del número del negocio y quedan en la conversación, para que el asistente los vea', async () => {
    const tenant = await readyTenant();
    const id = await enqueueNotification(db, {
      tenantId: tenant.tenantId,
      recipient: 'customer',
      kind: 'deposit_confirmed',
      customerId: tenant.customerId,
      appointmentId: tenant.appointmentId,
      message: { type: 'text', body: '¡Seña recibida! Tu turno quedó confirmado.' },
      now: NOW,
    });
    const { client, sent } = fakeClient();

    await send(tenant, id, client, { phoneNumberId: '999000111', accessToken: 'EAAG-token-de-avisos' });

    expect(sent).toEqual([
      expect.objectContaining({ phoneNumberId: tenant.phoneNumberId, to: FIXTURE_CUSTOMER_PHONE }) as unknown,
    ]);
    const row = await notificationRow(id);
    expect(row.status).toBe('sent');
    const recorded = single(
      await db.select().from(messages).where(eq(messages.whatsappMessageId, row.whatsappMessageId ?? '')),
    );
    expect(recorded).toMatchObject({ conversationId: tenant.conversationId, direction: 'outbound' });
  });
});
