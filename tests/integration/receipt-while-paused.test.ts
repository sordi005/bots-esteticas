import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { processConversation, type Responder } from '../../src/modules/conversation/processing.js';
import { conversations, handoffs, messages } from '../../src/modules/conversation/schema.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { notifications } from '../../src/modules/notifications/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { bookAppointment } from '../../src/modules/scheduling/booking.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import type { WhatsAppClient } from '../../src/modules/whatsapp/client.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, single, type BookableFixture } from './support/fixtures.js';

/**
 * El comprobante que llega con el asistente pausado por una derivación (4.5, 4.8, decisión 34): el
 * código lo registra igual, sin llamar al modelo ni contestarle a la clienta. Lo encontró la prueba
 * manual de H9: la foto se marcaba como procesada y el turno quedaba pendiente de seña hasta vencerse.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = createLogger({ logLevel: 'silent' });

afterAll(() => database.close());

beforeEach(async () => {
  await db.delete(scheduledJobs);
});

const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const NOW = at('2026-10-05', '10:00');

type Fixture = BookableFixture & { conversationId: string };

async function pausedConversation(settings: Parameters<typeof createBookableFixture>[1] = {}): Promise<Fixture> {
  const fixture = await createBookableFixture(db, settings);
  const { id: conversationId } = single(
    await db
      .insert(conversations)
      .values({
        tenantId: fixture.tenantId,
        customerId: fixture.customerId,
        assistantStatus: 'paused',
        pausedUntil: new Date(NOW.getTime() + 6 * 60 * 60 * 1_000),
      })
      .returning({ id: conversations.id }),
  );
  return { ...fixture, conversationId };
}

async function book(f: Fixture, date: string, time: string): Promise<string> {
  const booked = await bookAppointment(db, {
    tenantId: f.tenantId,
    customerId: f.customerId,
    serviceId: f.serviceId,
    professionalId: f.professionalId,
    start: at(date, time),
    actor: 'assistant',
    now: new Date(NOW.getTime() - 10 * 60_000),
  });
  if (!booked.ok) throw new Error(booked.reason);
  return booked.appointmentId;
}

async function receive(f: Fixture, message: { type: string; content: Record<string, unknown> }) {
  await db.insert(messages).values({
    tenantId: f.tenantId,
    conversationId: f.conversationId,
    direction: 'inbound',
    type: message.type,
    content: message.content,
    whatsappMessageId: `wamid.${randomUUID()}`,
    occurredAt: new Date(NOW.getTime() - 5_000),
  });
}

const photo = (id: string) => ({ type: 'image', content: { type: 'image', image: { id, mime_type: 'image/jpeg' } } });

function process(f: Fixture) {
  const respond = vi.fn<Responder>(() => Promise.resolve({ type: 'text', body: 'no debería salir' }));
  const sendMessage = vi.fn<WhatsAppClient['sendMessage']>();
  const result = processConversation(
    { db, logger, client: { sendMessage }, credentialsKey: Buffer.alloc(32), respond, now: () => NOW },
    { tenantId: f.tenantId, conversationId: f.conversationId, signal: new AbortController().signal },
  );
  return { result, respond, sendMessage };
}

const statusOf = async (appointmentId: string) =>
  single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId)))
    .status;

const ownerNoticesOf = (f: Fixture) =>
  db
    .select({ kind: notifications.kind, receiptMediaId: notifications.receiptMediaId })
    .from(notifications)
    .where(and(eq(notifications.tenantId, f.tenantId), eq(notifications.recipient, 'owner')));

const unprocessedOf = (f: Fixture) =>
  db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.tenantId, f.tenantId), eq(messages.direction, 'inbound'), isNull(messages.processedAt)));

describe('comprobante con el asistente pausado (4.5, 4.8)', () => {
  it('lo registra: turno en verificación, aviso a la dueña con la imagen y recordatorio, sin modelo ni respuesta', async () => {
    const f = await pausedConversation();
    const appointmentId = await book(f, '2026-10-06', '10:00');
    await receive(f, photo('media-en-pausa'));

    const { result, respond, sendMessage } = process(f);

    expect(await result).toBe('paused');
    expect(respond).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await statusOf(appointmentId)).toBe('DEPOSIT_REVIEW');
    expect(await ownerNoticesOf(f)).toEqual([{ kind: 'deposit_receipt', receiptMediaId: 'media-en-pausa' }]);
    const jobs = await db
      .select({ kind: scheduledJobs.kind })
      .from(scheduledJobs)
      .where(eq(scheduledJobs.tenantId, f.tenantId));
    expect(jobs.map((job) => job.kind)).toContain('remind_deposit_receipt');
    expect(await unprocessedOf(f)).toEqual([]);
  });

  it('la pausa sigue como estaba: registrar el comprobante no reanuda al asistente', async () => {
    const f = await pausedConversation();
    await book(f, '2026-10-06', '10:00');
    await receive(f, photo('media-1'));

    await process(f).result;

    expect(
      single(
        await db
          .select({ status: conversations.assistantStatus })
          .from(conversations)
          .where(eq(conversations.id, f.conversationId)),
      ).status,
    ).toBe('paused');
  });

  it('una imagen sin seña pendiente no cambia nada', async () => {
    const f = await pausedConversation();
    await receive(f, photo('una-foto-de-uñas'));

    const { result, respond } = process(f);

    expect(await result).toBe('paused');
    expect(respond).not.toHaveBeenCalled();
    expect(await ownerNoticesOf(f)).toEqual([]);
    expect(await unprocessedOf(f)).toEqual([]);
  });

  it('con varias señas pendientes no registra ninguna ni vuelve a derivar: ya la atiende una persona', async () => {
    const f = await pausedConversation();
    const first = await book(f, '2026-10-06', '10:00');
    const second = await book(f, '2026-10-07', '10:00');
    await receive(f, photo('media-dudosa'));

    await process(f).result;

    expect(await statusOf(first)).toBe('PENDING_DEPOSIT');
    expect(await statusOf(second)).toBe('PENDING_DEPOSIT');
    expect(await ownerNoticesOf(f)).toEqual([]);
    expect(await db.select().from(handoffs).where(eq(handoffs.conversationId, f.conversationId))).toEqual([]);
  });

  it('un texto en la pausa sigue sin hacer nada', async () => {
    const f = await pausedConversation();
    await book(f, '2026-10-06', '10:00');
    await receive(f, { type: 'text', content: { type: 'text', text: { body: 'ya te pagué' } } });

    await process(f).result;

    const [deposit] = await db
      .select({ receiptMediaId: deposits.receiptMediaId })
      .from(deposits)
      .where(eq(deposits.tenantId, f.tenantId));
    expect(deposit?.receiptMediaId).toBeNull();
    expect(await ownerNoticesOf(f)).toEqual([]);
  });
});

describe('«Confirmo» del recordatorio con el asistente pausado (4.7, H10)', () => {
  it('se registra igual, sin llamar al modelo ni contestar: lo atiende una persona', async () => {
    const f = await pausedConversation({ settings: { depositRequirement: 'never' } });
    const appointmentId = await book(f, '2026-10-06', '10:00');
    await receive(f, {
      type: 'button',
      content: { type: 'button', button: { payload: `recordatorio:${appointmentId}:confirmar`, text: 'Confirmo' } },
    });

    const { result, respond, sendMessage } = process(f);

    expect(await result).toBe('paused');
    expect(respond).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    const events = await db.select().from(appointmentEvents).where(eq(appointmentEvents.appointmentId, appointmentId));
    expect(events.map((event) => event.kind)).toContain('attendance_confirmed');
    expect(await unprocessedOf(f)).toEqual([]);
  });
});
