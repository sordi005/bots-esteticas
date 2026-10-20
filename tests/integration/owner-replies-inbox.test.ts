import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { recordWebhookEvents } from '../../src/modules/conversation/inbox.js';
import { handoffs, messages } from '../../src/modules/conversation/schema.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { enqueueNotification } from '../../src/modules/notifications/outbox.js';
import { ownerReplies } from '../../src/modules/notifications/schema.js';
import { tenants } from '../../src/modules/tenants/schema.js';
import { parseWebhook } from '../../src/modules/whatsapp/webhook-payload.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture } from './support/fixtures.js';
import { buttonReplyWebhook, connectWhatsApp, textMessageWebhook } from './support/whatsapp.js';

/**
 * Las respuestas de la dueña a los avisos (6.5, paso 2). Con número de avisos, todo lo que entra
 * por ahí es de una dueña. En la fase 0 los avisos salen del número del negocio: ahí es de la
 * dueña solo un botón `aviso:` que toca el teléfono de la dueña. El webhook solo guarda y programa.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const NOW = new Date('2026-10-05T13:00:00.000Z');
const NOTIFICATIONS_NUMBER = '777000111222';

afterAll(() => database.close());

/** Un número de dueña distinto por negocio: los tests no se pisan. */
const ownerWaId = () => `54926155${String(Math.floor(Math.random() * 100_000)).padStart(5, '0')}`;

async function tenantWithNotice() {
  const fixture = await createTenantFixture(db);
  const phoneNumberId = await connectWhatsApp(db, fixture.tenantId);
  const owner = ownerWaId();
  await db.update(tenants).set({ ownerPhone: `+${owner}` }).where(eq(tenants.id, fixture.tenantId));
  const [handoff] = await db
    .insert(handoffs)
    .values({ tenantId: fixture.tenantId, conversationId: fixture.conversationId, reason: 'complaint', summary: 'Reclamo' })
    .returning({ id: handoffs.id });
  const noticeId = await enqueueNotification(db, {
    tenantId: fixture.tenantId,
    recipient: 'owner',
    kind: 'handoff',
    customerId: fixture.customerId,
    handoffId: handoff?.id ?? '',
    message: { type: 'text', body: 'Aviso' },
    now: NOW,
  });
  return { ...fixture, phoneNumberId, owner, noticeId };
}

function record(body: string) {
  return recordWebhookEvents(db, parseWebhook(JSON.parse(body)).events, {
    now: NOW,
    notificationsPhoneNumberId: NOTIFICATIONS_NUMBER,
  });
}

function button(input: { phoneNumberId: string; from: string; replyId: string; messageId?: string }) {
  return buttonReplyWebhook({
    ...input,
    messageId: input.messageId ?? `wamid.${randomUUID()}`,
    title: 'Recibida',
  });
}

async function repliesOf(tenantId: string) {
  return db.select().from(ownerReplies).where(eq(ownerReplies.tenantId, tenantId));
}

async function inboundOf(tenantId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.direction, 'inbound')));
}

describe('fase 0: los avisos salen del número del negocio', () => {
  it('un botón de aviso que toca la dueña se guarda como su respuesta y programa su proceso', async () => {
    const tenant = await tenantWithNotice();

    const summary = await record(
      button({ phoneNumberId: tenant.phoneNumberId, from: tenant.owner, replyId: `aviso:${tenant.noticeId}:atendida` }),
    );

    expect(summary).toMatchObject({ ownerReplies: 1, stored: 0 });
    const [reply] = await repliesOf(tenant.tenantId);
    expect(reply).toMatchObject({ notificationId: tenant.noticeId, action: 'handoff_attended', processedAt: null });
    const job = await db
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.tenantId, tenant.tenantId), eq(scheduledJobs.kind, 'process_owner_reply')));
    expect(job).toMatchObject([{ key: reply?.id, status: 'pending', runAt: NOW }]);
    // No es un mensaje de clienta: el asistente no lo ve.
    expect(await inboundOf(tenant.tenantId)).toEqual([]);
  });

  it('el mismo botón reenviado por Meta se guarda una sola vez', async () => {
    const tenant = await tenantWithNotice();
    const body = button({
      phoneNumberId: tenant.phoneNumberId,
      from: tenant.owner,
      replyId: `aviso:${tenant.noticeId}:atendida`,
      messageId: `wamid.${randomUUID()}`,
    });

    await record(body);
    const again = await record(body);

    expect(again).toMatchObject({ ownerReplies: 0, duplicates: 1 });
    expect(await repliesOf(tenant.tenantId)).toHaveLength(1);
  });

  it('un botón de aviso tocado desde otro teléfono es un mensaje de clienta, no una respuesta de la dueña', async () => {
    const tenant = await tenantWithNotice();

    await record(
      button({ phoneNumberId: tenant.phoneNumberId, from: '5492614999999', replyId: `aviso:${tenant.noticeId}:atendida` }),
    );

    expect(await repliesOf(tenant.tenantId)).toEqual([]);
    expect(await inboundOf(tenant.tenantId)).toHaveLength(1);
  });

  it('un texto de la dueña es un mensaje de clienta (en la demo, la dueña también prueba como clienta)', async () => {
    const tenant = await tenantWithNotice();

    await record(
      textMessageWebhook({ phoneNumberId: tenant.phoneNumberId, from: tenant.owner, messageId: `wamid.${randomUUID()}`, text: 'hola' }),
    );

    expect(await repliesOf(tenant.tenantId)).toEqual([]);
    expect(await inboundOf(tenant.tenantId)).toHaveLength(1);
  });

  it('el botón de un aviso de otro negocio no se guarda en ninguno (regla 1)', async () => {
    const tenant = await tenantWithNotice();
    const other = await tenantWithNotice();

    const summary = await record(
      button({ phoneNumberId: tenant.phoneNumberId, from: tenant.owner, replyId: `aviso:${other.noticeId}:atendida` }),
    );

    expect(summary).toMatchObject({ ownerReplies: 0, ownerIgnored: 1 });
    expect(await repliesOf(tenant.tenantId)).toEqual([]);
    expect(await repliesOf(other.tenantId)).toEqual([]);
    expect(await inboundOf(tenant.tenantId)).toEqual([]);
  });
});

describe('un botón que no es de ese aviso', () => {
  it('«Recibida» sobre una derivación no se guarda', async () => {
    const tenant = await tenantWithNotice();

    const summary = await record(
      button({ phoneNumberId: tenant.phoneNumberId, from: tenant.owner, replyId: `aviso:${tenant.noticeId}:recibida` }),
    );

    expect(summary).toMatchObject({ ownerReplies: 0, ownerIgnored: 1 });
    expect(await repliesOf(tenant.tenantId)).toEqual([]);
  });
});

describe('con número de avisos del servicio (8.2)', () => {
  it('un botón de la dueña se guarda en el negocio del aviso', async () => {
    const tenant = await tenantWithNotice();

    const summary = await record(
      button({ phoneNumberId: NOTIFICATIONS_NUMBER, from: tenant.owner, replyId: `aviso:${tenant.noticeId}:atendida` }),
    );

    expect(summary).toMatchObject({ ownerReplies: 1, unknownNumber: 0 });
    expect(await repliesOf(tenant.tenantId)).toMatchObject([{ action: 'handoff_attended' }]);
  });

  it('el aviso de un negocio que no es de esa dueña no se guarda (regla 1)', async () => {
    const tenant = await tenantWithNotice();
    const other = await tenantWithNotice();

    const summary = await record(
      button({ phoneNumberId: NOTIFICATIONS_NUMBER, from: tenant.owner, replyId: `aviso:${other.noticeId}:atendida` }),
    );

    expect(summary).toMatchObject({ ownerReplies: 0, ownerIgnored: 1 });
    expect(await repliesOf(other.tenantId)).toEqual([]);
  });

  it('un texto al número de avisos no se guarda como mensaje de nadie', async () => {
    const tenant = await tenantWithNotice();

    const summary = await record(
      textMessageWebhook({ phoneNumberId: NOTIFICATIONS_NUMBER, from: tenant.owner, messageId: `wamid.${randomUUID()}`, text: 'gracias' }),
    );

    expect(summary).toMatchObject({ ownerReplies: 0, ownerIgnored: 1, stored: 0, unknownNumber: 0 });
    expect(await inboundOf(tenant.tenantId)).toEqual([]);
  });
});
