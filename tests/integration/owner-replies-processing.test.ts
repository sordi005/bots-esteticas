import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { handOff } from '../../src/modules/conversation/handoff.js';
import { processOwnerReply } from '../../src/modules/conversation/owner-replies.js';
import { conversations, handoffs } from '../../src/modules/conversation/schema.js';
import { enqueueNotification } from '../../src/modules/notifications/outbox.js';
import type { OwnerReplyAction } from '../../src/modules/notifications/owner-buttons.js';
import { notifications, ownerReplies } from '../../src/modules/notifications/schema.js';
import {
  bookAppointment,
  changeAppointmentStatus,
  submitTransferReceipt,
} from '../../src/modules/scheduling/booking.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { noticeBody } from './support/notices.js';
import { createBookableFixture, single, type BookableFixture } from './support/fixtures.js';

/**
 * Lo que pasa cuando la dueña toca un botón (4.5, 4.8). Cada cambio y sus avisos van juntos, y un
 * botón se procesa una sola vez y solo si lo que decide sigue pendiente.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = pino({ level: 'silent' });

afterAll(() => database.close());

const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const BOOKED_AT = at('2026-10-04', '09:00');
const RECEIPT_AT = at('2026-10-04', '09:20');
const NOW = at('2026-10-04', '11:00');

const runReply = (tenantId: string, ownerReplyId: string, now = NOW) =>
  processOwnerReply({ db, logger, now: () => now }, { tenantId, ownerReplyId });

async function conversationFor(fixture: BookableFixture) {
  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId: fixture.tenantId, customerId: fixture.customerId })
    .returning({ id: conversations.id });
  return conversation?.id ?? '';
}

/** Un turno con el comprobante en verificación y el aviso a la dueña. */
async function receiptInReview() {
  const fixture = await createBookableFixture(db);
  const conversationId = await conversationFor(fixture);
  const booked = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: at('2026-10-05', '10:00'),
    actor: 'assistant',
    now: BOOKED_AT,
  });
  if (!booked.ok || !booked.deposit) throw new Error('La reserva de prueba no quedó pendiente de seña');
  const depositId = booked.deposit.id;
  await submitTransferReceipt(db, { tenantId: fixture.tenantId, depositId, mediaId: 'media-1', now: RECEIPT_AT });
  const noticeId = await enqueueNotification(db, {
    tenantId: fixture.tenantId,
    recipient: 'owner',
    kind: 'deposit_receipt',
    customerId: fixture.customerId,
    appointmentId: booked.appointmentId,
    depositId,
    receiptMediaId: 'media-1',
    message: { type: 'buttons', body: '¿Llegó?', buttons: [{ id: 'x', title: 'Recibida' }] },
    now: RECEIPT_AT,
  });
  return { ...fixture, conversationId, appointmentId: booked.appointmentId, depositId, noticeId };
}

async function reply(tenantId: string, notificationId: string, action: OwnerReplyAction) {
  const [row] = await db
    .insert(ownerReplies)
    .values({ tenantId, notificationId, action, whatsappMessageId: `wamid.${randomUUID()}`, receivedAt: NOW })
    .returning({ id: ownerReplies.id });
  return row?.id ?? '';
}

async function statusOf(appointmentId: string) {
  return single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId)))
    .status;
}

/** Los avisos que dejó el botón (sin el del comprobante). */
async function noticesAfter(tenantId: string, kindToSkip = 'deposit_receipt') {
  const rows = await db.select().from(notifications).where(eq(notifications.tenantId, tenantId));
  return rows.filter((row) => row.kind !== kindToSkip);
}

async function processedAt(ownerReplyId: string) {
  return single(await db.select().from(ownerReplies).where(eq(ownerReplies.id, ownerReplyId))).processedAt;
}

describe('«Recibida» y «No llegó» (4.5)', () => {
  it('«Recibida» confirma el turno, le avisa a la clienta y le confirma a la dueña', async () => {
    const t = await receiptInReview();
    const id = await reply(t.tenantId, t.noticeId, 'deposit_received');

    expect(await runReply(t.tenantId, id)).toBe('deposit_confirmed');

    expect(await statusOf(t.appointmentId)).toBe('CONFIRMED');
    const notices = await noticesAfter(t.tenantId);
    expect(notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recipient: 'customer', kind: 'deposit_confirmed', customerId: t.customerId }),
        expect.objectContaining({ recipient: 'owner', kind: 'owner_reply_ack' }),
      ]) as unknown,
    );
    expect(notices).toHaveLength(2);
    expect(noticeBody(notices.find((n) => n.kind === 'deposit_confirmed')?.message)).toMatch(/^¡Seña recibida!/);
    expect(await processedAt(id)).toEqual(NOW);
  });

  it('«No llegó» rechaza, le avisa a la clienta y pausa la conversación con una derivación «pago», sin otro aviso', async () => {
    const t = await receiptInReview();
    const id = await reply(t.tenantId, t.noticeId, 'deposit_not_received');

    expect(await runReply(t.tenantId, id)).toBe('deposit_rejected');

    expect(await statusOf(t.appointmentId)).toBe('DEPOSIT_REJECTED');
    const notices = await noticesAfter(t.tenantId);
    expect(notices.map((n) => n.kind).sort()).toEqual(['deposit_rejected', 'owner_reply_ack']);
    expect(noticeBody(notices.find((n) => n.kind === 'owner_reply_ack')?.message)).toMatch(/pausa/);
    const conversation = single(await db.select().from(conversations).where(eq(conversations.id, t.conversationId)));
    expect(conversation.assistantStatus).toBe('paused');
    expect(
      await db.select().from(handoffs).where(and(eq(handoffs.tenantId, t.tenantId), eq(handoffs.conversationId, t.conversationId))),
    ).toMatchObject([{ reason: 'payment_issue', status: 'open' }]);
  });

  it('un botón ya procesado no hace nada más (la tarea puede correr dos veces, regla 7)', async () => {
    const t = await receiptInReview();
    const id = await reply(t.tenantId, t.noticeId, 'deposit_received');
    await runReply(t.tenantId, id);

    expect(await runReply(t.tenantId, id)).toBe('already_processed');

    expect(await noticesAfter(t.tenantId)).toHaveLength(2);
  });

  it('el otro botón después de decidir no cambia nada y le cuenta a la dueña cómo quedó', async () => {
    const t = await receiptInReview();
    await runReply(t.tenantId, await reply(t.tenantId, t.noticeId, 'deposit_received'));
    const second = await reply(t.tenantId, t.noticeId, 'deposit_not_received');

    expect(await runReply(t.tenantId, second)).toBe('unchanged');

    expect(await statusOf(t.appointmentId)).toBe('CONFIRMED');
    const acks = (await noticesAfter(t.tenantId)).filter((n) => n.kind === 'owner_reply_ack');
    expect(noticeBody(acks.at(-1)?.message)).toContain('ya estaba confirmado');
    expect(await processedAt(second)).toEqual(NOW);
  });

  it('si la clienta canceló mientras tanto, no se confirma ni se le avisa: la dueña se entera', async () => {
    const t = await receiptInReview();
    await changeAppointmentStatus(db, {
      tenantId: t.tenantId,
      appointmentId: t.appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: RECEIPT_AT,
    });
    const id = await reply(t.tenantId, t.noticeId, 'deposit_received');

    expect(await runReply(t.tenantId, id)).toBe('unchanged');

    const notices = await noticesAfter(t.tenantId);
    expect(notices.map((n) => n.kind)).toEqual(['owner_reply_ack']);
    expect(noticeBody(notices[0]?.message)).toContain('canceló ese turno');
  });

  it('no procesa el botón de otro negocio (regla 1)', async () => {
    const t = await receiptInReview();
    const other = await createBookableFixture(db);
    const id = await reply(t.tenantId, t.noticeId, 'deposit_received');

    expect(await runReply(other.tenantId, id)).toBe('not_found');

    expect(await statusOf(t.appointmentId)).toBe('DEPOSIT_REVIEW');
  });
});

describe('«Ya la atendí» (4.8)', () => {
  async function derived(now = at('2026-10-04', '10:00')) {
    const fixture = await createBookableFixture(db);
    const conversationId = await conversationFor(fixture);
    const { handoffId } = await handOff(db, {
      tenantId: fixture.tenantId,
      conversationId,
      reason: 'complaint',
      summary: 'Se quejó del turno de ayer',
      now,
    });
    const notice = single(
      await db.select().from(notifications).where(and(eq(notifications.tenantId, fixture.tenantId), eq(notifications.handoffId, handoffId))),
    );
    return { ...fixture, conversationId, handoffId, noticeId: notice.id };
  }

  const handoffRow = async (id: string) => single(await db.select().from(handoffs).where(eq(handoffs.id, id)));
  const conversationRow = async (id: string) => single(await db.select().from(conversations).where(eq(conversations.id, id)));
  const lastAck = async (tenantId: string) =>
    noticeBody((await noticesAfter(tenantId, 'handoff')).filter((n) => n.kind === 'owner_reply_ack').at(-1)?.message);

  it('resuelve la derivación y reanuda el asistente desde ahora', async () => {
    const t = await derived();
    const id = await reply(t.tenantId, t.noticeId, 'handoff_attended');

    expect(await runReply(t.tenantId, id)).toBe('handoff_resolved');

    expect(await handoffRow(t.handoffId)).toMatchObject({ status: 'resolved', resolvedAt: NOW });
    expect(await conversationRow(t.conversationId)).toMatchObject({
      assistantStatus: 'active',
      pausedUntil: null,
      resumedAt: NOW,
    });
    expect(await lastAck(t.tenantId)).toContain('vuelve a contestar');
  });

  it('si el asistente ya se había reanudado, solo la marca como resuelta', async () => {
    const t = await derived();
    await db
      .update(conversations)
      .set({ assistantStatus: 'active', pausedUntil: null, resumedAt: at('2026-10-04', '10:30') })
      .where(eq(conversations.id, t.conversationId));
    const id = await reply(t.tenantId, t.noticeId, 'handoff_attended');

    await runReply(t.tenantId, id);

    expect((await handoffRow(t.handoffId)).status).toBe('resolved');
    expect((await conversationRow(t.conversationId)).resumedAt).toEqual(at('2026-10-04', '10:30'));
    expect(await lastAck(t.tenantId)).not.toContain('vuelve a contestar');
  });

  it('con una derivación más nueva abierta, resuelve la vieja y el asistente sigue en pausa', async () => {
    const t = await derived(at('2026-10-03', '09:00'));
    // La pausa vieja venció y llegó otra derivación.
    await handOff(db, {
      tenantId: t.tenantId,
      conversationId: t.conversationId,
      reason: 'customer_request',
      summary: 'Pidió hablar con una persona',
      now: at('2026-10-04', '10:00'),
    });
    const id = await reply(t.tenantId, t.noticeId, 'handoff_attended');

    await runReply(t.tenantId, id);

    expect((await handoffRow(t.handoffId)).status).toBe('resolved');
    expect((await conversationRow(t.conversationId)).assistantStatus).toBe('paused');
  });

  it('una derivación ya resuelta no cambia nada', async () => {
    const t = await derived();
    await runReply(t.tenantId, await reply(t.tenantId, t.noticeId, 'handoff_attended'));
    const second = await reply(t.tenantId, t.noticeId, 'handoff_attended');

    expect(await runReply(t.tenantId, second, at('2026-10-04', '12:00'))).toBe('unchanged');

    expect((await handoffRow(t.handoffId)).resolvedAt).toEqual(NOW);
    expect(await lastAck(t.tenantId)).toContain('ya estaba atendida');
  });
});
