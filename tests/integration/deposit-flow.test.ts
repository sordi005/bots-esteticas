import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { registerTransferReceipt } from '../../src/modules/conversation/deposit-receipts.js';
import { recordWebhookEvents } from '../../src/modules/conversation/inbox.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { notifications } from '../../src/modules/notifications/schema.js';
import { bookAppointment } from '../../src/modules/scheduling/booking.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import { saveCredential } from '../../src/modules/tenants/credentials.js';
import { tenants } from '../../src/modules/tenants/schema.js';
import type { SendMessageInput, WhatsAppClient, WhatsAppMediaClient } from '../../src/modules/whatsapp/client.js';
import { parseWebhook } from '../../src/modules/whatsapp/webhook-payload.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { buildWorker } from '../../src/worker.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, FIXTURE_CUSTOMER_PHONE, single } from './support/fixtures.js';
import { buttonReplyWebhook, connectWhatsApp } from './support/whatsapp.js';

/**
 * El flujo de la seña por transferencia de punta a punta, con el worker (4.5, criterio de H9): el
 * comprobante llega, la dueña recibe el aviso con la imagen, toca «Recibida» y la clienta recibe
 * la confirmación. En la fase 0 todo sale del número del negocio.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const credentialsKey = randomBytes(32);
const logger = createLogger({ logLevel: 'silent' });
const OWNER_WA_ID = '5492615550000';

afterAll(() => database.close());

// La cola es una sola para todos los negocios: un claim tomaría las tareas de otro test.
beforeEach(async () => {
  await db.delete(scheduledJobs);
});

const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');

function fakeClient() {
  const sent: SendMessageInput[] = [];
  const client: WhatsAppClient & WhatsAppMediaClient = {
    sendMessage: (input) => {
      sent.push(input);
      return Promise.resolve({ messageId: `wamid.${randomUUID()}` });
    },
    downloadMedia: () => Promise.resolve({ data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }),
    uploadMedia: () => Promise.resolve({ mediaId: 'media-subida' }),
  };
  return { client, sent };
}

describe('seña por transferencia, de punta a punta con el worker', () => {
  it('comprobante → aviso con la imagen → «Recibida» → turno confirmado, aviso a la clienta y respuesta a la dueña', async () => {
    let now = at('2026-10-05', '09:00');
    const fixture = await createBookableFixture(db);
    const phoneNumberId = await connectWhatsApp(db, fixture.tenantId);
    await saveCredential(db, credentialsKey, {
      tenantId: fixture.tenantId,
      kind: 'whatsapp',
      value: { accessToken: 'EAAG-token-del-negocio' },
    });
    await db.update(tenants).set({ ownerPhone: `+${OWNER_WA_ID}` }).where(eq(tenants.id, fixture.tenantId));
    const { client, sent } = fakeClient();
    const worker = buildWorker({
      db,
      logger,
      now: () => now,
      notifications: { client, credentialsKey },
    });
    onTestFinished(() => worker.stop());

    const booked = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: fixture.customerId,
      serviceId: fixture.serviceId,
      professionalId: fixture.professionalId,
      start: at('2026-10-06', '10:00'),
      actor: 'assistant',
      now,
    });
    if (!booked.ok) throw new Error(booked.reason);

    // 1. Llega el comprobante: el aviso a la dueña sale con la imagen y los dos botones.
    now = at('2026-10-05', '09:20');
    await registerTransferReceipt(db, { tenantId: fixture.tenantId, customerId: fixture.customerId, mediaId: 'media-1', now });
    await worker.runOnce();

    expect(sent).toHaveLength(1);
    const [notice] = sent;
    expect(notice).toMatchObject({
      phoneNumberId,
      to: `+${OWNER_WA_ID}`,
      message: { type: 'buttons', header: { type: 'image', imageId: 'media-subida' } },
    });
    const received = notice?.message.type === 'buttons' ? notice.message.buttons[0] : undefined;
    expect(received?.title).toBe('Recibida');

    // 2. La dueña toca «Recibida» en el mismo chat del número de prueba (fase 0).
    now = at('2026-10-05', '09:40');
    await recordWebhookEvents(
      db,
      parseWebhook(
        JSON.parse(
          buttonReplyWebhook({
            phoneNumberId,
            from: OWNER_WA_ID,
            messageId: `wamid.${randomUUID()}`,
            replyId: received?.id ?? '',
            title: 'Recibida',
          }),
        ),
      ).events,
      { now },
    );
    await worker.runOnce(); // procesa el botón
    await worker.runOnce(); // envía los avisos que dejó

    expect(
      single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, booked.appointmentId))).status,
    ).toBe('CONFIRMED');
    expect(sent.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: FIXTURE_CUSTOMER_PHONE,
          message: expect.objectContaining({ body: expect.stringMatching(/^¡Seña recibida! Tu turno de .+ quedó confirmado/) as unknown }) as unknown,
        }),
        expect.objectContaining({
          to: `+${OWNER_WA_ID}`,
          message: expect.objectContaining({ body: expect.stringMatching(/^Listo: le avisé a Caro Pérez/) as unknown }) as unknown,
        }),
      ]) as unknown,
    );
    const pending = await db.select().from(notifications).where(eq(notifications.status, 'pending'));
    expect(pending.filter((row) => row.tenantId === fixture.tenantId)).toEqual([]);
  });
});
