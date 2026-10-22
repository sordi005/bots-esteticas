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
import type { TemplateMessage } from '../../src/modules/whatsapp/outgoing.js';
import { createDatabase } from '../../src/shared/db.js';
import { UNIQUE_VIOLATION } from '../../src/shared/postgres-errors.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, FIXTURE_CUSTOMER_PHONE, single } from './support/fixtures.js';
import { expectConstraintViolation } from './support/postgres-errors.js';
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

/** `fail` decide por mensaje: así un test puede rechazar el mensaje libre y aceptar la plantilla. */
function fakeClient(options: { fail?: (input: SendMessageInput) => Error | undefined } = {}) {
  const sent: SendMessageInput[] = [];
  const downloads: { mediaId: string; accessToken: string }[] = [];
  const uploads: { phoneNumberId: string; accessToken: string; mimeType: string }[] = [];
  const client: WhatsAppClient & WhatsAppMediaClient = {
    sendMessage: (input) => {
      const error = options.fail?.(input);
      if (error) return Promise.reject(error);
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

const outsideWindow = () => new WhatsAppApiError('Meta rechazó el mensaje: Re-engagement message', 400, 131047);

const CANCELLATION_TEMPLATE: TemplateMessage = {
  type: 'template',
  name: 'aviso_cancelacion',
  language: 'es_AR',
  params: { clienta: 'Caro', turno: 'Semi con Mica, lunes 5/10 10:00', sena: 'sin pagar' },
};

function ownerNotice(tenant: Tenant, template?: TemplateMessage) {
  return enqueueNotification(db, {
    tenantId: tenant.tenantId,
    recipient: 'owner',
    kind: 'appointment_cancelled',
    customerId: tenant.customerId,
    appointmentId: tenant.appointmentId,
    message: { type: 'text', body: 'Caro canceló su turno' },
    ...(template ? { template } : {}),
    now: NOW,
  });
}

async function receiptNotice(tenant: Tenant, template?: TemplateMessage) {
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
    ...(template ? { template } : {}),
    now: NOW,
  });
}

function send(
  tenant: Tenant,
  notificationId: string,
  client: WhatsAppClient & WhatsAppMediaClient,
  notificationsNumber?: { phoneNumberId: string; accessToken: string },
  preferTemplates = false,
) {
  return sendNotification(
    {
      db,
      logger,
      client,
      credentialsKey,
      now: () => NOW,
      preferTemplates,
      ...(notificationsNumber ? { notificationsNumber } : {}),
    },
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

  it('fuera de la ventana de 24 horas (131047), un aviso sin plantilla queda fallido sin reintentar', async () => {
    const tenant = await readyTenant();
    const id = await ownerNotice(tenant);
    const { client } = fakeClient({ fail: () => outsideWindow() });

    expect(await send(tenant, id, client)).toBe('failed');

    expect(await notificationRow(id)).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/131047/) as unknown });
  });

  it('fuera de la ventana de 24 horas, en la misma ejecución sale su plantilla (8.2, H10)', async () => {
    const tenant = await readyTenant();
    const id = await ownerNotice(tenant, CANCELLATION_TEMPLATE);
    const { client, sent } = fakeClient({ fail: ({ message }) => (message.type === 'template' ? undefined : outsideWindow()) });

    expect(await send(tenant, id, client)).toBe('sent');

    expect(sent).toEqual([expect.objectContaining({ to: OWNER_PHONE, message: CANCELLATION_TEMPLATE }) as unknown]);
    expect(await notificationRow(id)).toMatchObject({ status: 'sent', lastError: null });
  });

  it('el comprobante con plantilla también lleva la imagen como encabezado, subida una sola vez', async () => {
    const tenant = await readyTenant();
    const template = {
      type: 'template' as const,
      name: 'aviso_comprobante',
      language: 'es_AR',
      params: { clienta: 'Caro', monto: '$5.400', turno: 'Semi' },
      buttonPayloads: ['aviso:1:recibida', 'aviso:1:no_llego'],
    };
    const id = await receiptNotice(tenant, template);
    const { client, sent, uploads } = fakeClient({
      fail: ({ message }) => (message.type === 'template' ? undefined : outsideWindow()),
    });

    expect(await send(tenant, id, client)).toBe('sent');

    expect(uploads).toHaveLength(1);
    expect(sent[0]?.message).toEqual({ ...template, header: { type: 'image', imageId: 'media-subida' } });
  });

  it('una plantilla que Meta no acepta (no está aprobada, está pausada) queda fallida con su error, sin reintentar', async () => {
    const tenant = await readyTenant();
    const id = await ownerNotice(tenant, CANCELLATION_TEMPLATE);
    const { client } = fakeClient({
      fail: ({ message }) =>
        message.type === 'template'
          ? new WhatsAppApiError('Meta rechazó el mensaje: Template name does not exist in the translation', 404, 132001)
          : outsideWindow(),
    });

    expect(await send(tenant, id, client)).toBe('failed');

    expect(await notificationRow(id)).toMatchObject({
      status: 'failed',
      lastError: expect.stringMatching(/aviso_cancelacion.*132001/) as unknown,
    });
  });

  it('con preferTemplates (solo desarrollo) sale directo la plantilla, sin probar el mensaje libre', async () => {
    const tenant = await readyTenant();
    const id = await ownerNotice(tenant, CANCELLATION_TEMPLATE);
    const { client, sent } = fakeClient();

    await send(tenant, id, client, undefined, true);

    expect(sent.map((input) => input.message)).toEqual([CANCELLATION_TEMPLATE]);
  });

  it('con preferTemplates, un aviso sin plantilla sale como mensaje libre', async () => {
    const tenant = await readyTenant();
    const id = await ownerNotice(tenant);
    const { client, sent } = fakeClient();

    await send(tenant, id, client, undefined, true);

    expect(sent.map((input) => input.message.type)).toEqual(['text']);
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

describe('avisos a la clienta con plantilla (4.5, 4.7, H10)', () => {
  const confirmedTemplate: TemplateMessage = {
    type: 'template',
    name: 'sena_confirmada',
    language: 'es_AR',
    params: { servicio: 'Semi', profesional: 'Mica', fecha_hora: 'lunes 5/10 10:00' },
  };

  it('guarda la versión con plantilla y el inicio del turno junto con el aviso', async () => {
    const tenant = await readyTenant();
    const start = new Date('2026-10-06T13:00:00.000Z');

    const id = await enqueueNotification(db, {
      tenantId: tenant.tenantId,
      recipient: 'customer',
      kind: 'reservation_expired',
      customerId: tenant.customerId,
      appointmentId: tenant.appointmentId,
      appointmentStart: start,
      message: { type: 'text', body: 'Tu reserva se liberó' },
      template: { ...confirmedTemplate, name: 'reserva_vencida' },
      now: NOW,
    });

    expect(await notificationRow(id)).toMatchObject({ appointmentStart: start, template: { name: 'reserva_vencida' } });
  });

  it('fuera de la ventana sale la plantilla por el número del negocio y queda en la conversación como plantilla', async () => {
    const tenant = await readyTenant();
    const id = await enqueueNotification(db, {
      tenantId: tenant.tenantId,
      recipient: 'customer',
      kind: 'deposit_confirmed',
      customerId: tenant.customerId,
      appointmentId: tenant.appointmentId,
      message: { type: 'text', body: '¡Seña recibida!' },
      template: confirmedTemplate,
      now: NOW,
    });
    const { client, sent } = fakeClient({ fail: ({ message }) => (message.type === 'template' ? undefined : outsideWindow()) });

    expect(await send(tenant, id, client)).toBe('sent');

    expect(sent).toEqual([
      expect.objectContaining({ phoneNumberId: tenant.phoneNumberId, to: FIXTURE_CUSTOMER_PHONE, message: confirmedTemplate }) as unknown,
    ]);
    const recorded = single(
      await db.select().from(messages).where(eq(messages.whatsappMessageId, (await notificationRow(id)).whatsappMessageId ?? '')),
    );
    expect(recorded).toMatchObject({ type: 'template', content: confirmedTemplate });
  });

  it('un recordatorio ya es una plantilla: sale tal cual', async () => {
    const tenant = await readyTenant();
    const reminder: TemplateMessage = {
      type: 'template',
      name: 'recordatorio_turno',
      language: 'es_AR',
      params: { servicio: 'Semi', profesional: 'Mica', fecha_hora: 'martes 6/10 10:00' },
      buttonPayloads: ['recordatorio:a:confirmar', 'recordatorio:a:reprogramar', 'recordatorio:a:cancelar'],
    };
    const id = await enqueueNotification(db, {
      tenantId: tenant.tenantId,
      recipient: 'customer',
      kind: 'appointment_reminder',
      customerId: tenant.customerId,
      appointmentId: tenant.appointmentId,
      appointmentStart: new Date('2026-10-06T13:00:00.000Z'),
      message: reminder,
      now: NOW,
    });
    const { client, sent } = fakeClient();

    expect(await send(tenant, id, client)).toBe('sent');

    expect(sent.map((input) => input.message)).toEqual([reminder]);
  });

  it('dos recordatorios del mismo turno e inicio no pueden existir: lo impide la base', async () => {
    const tenant = await readyTenant();
    const reminder = {
      tenantId: tenant.tenantId,
      recipient: 'customer' as const,
      kind: 'appointment_reminder' as const,
      customerId: tenant.customerId,
      appointmentId: tenant.appointmentId,
      appointmentStart: new Date('2026-10-06T13:00:00.000Z'),
      message: { type: 'text' as const, body: 'Recordatorio' },
      now: NOW,
    };
    await enqueueNotification(db, reminder);

    await expectConstraintViolation(enqueueNotification(db, reminder), UNIQUE_VIOLATION, 'notifications_once_per_appointment_key');
  });
});
