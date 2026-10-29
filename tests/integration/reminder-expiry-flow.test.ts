import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { bookAppointment } from '../../src/modules/scheduling/booking.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import { saveCredential } from '../../src/modules/tenants/credentials.js';
import {
  WhatsAppApiError,
  type SendMessageInput,
  type WhatsAppClient,
  type WhatsAppMediaClient,
} from '../../src/modules/whatsapp/client.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { buildWorker } from '../../src/worker.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, FIXTURE_CUSTOMER_PHONE, single, type BookableFixture } from './support/fixtures.js';
import { connectWhatsApp } from './support/whatsapp.js';

/**
 * Los recordatorios y el vencimiento de punta a punta, con el worker (criterio de H10): la reserva
 * programa sus tareas, el worker las corre a su hora y la clienta recibe el mensaje.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const credentialsKey = randomBytes(32);
const logger = createLogger({ logLevel: 'silent' });

afterAll(() => database.close());

// La cola es una sola para todos los negocios: un claim tomaría las tareas de otro test.
beforeEach(async () => {
  await db.delete(scheduledJobs);
});

// Octubre de 2026 en Mendoza: el 4 es domingo y el 5 lunes.
const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');

function fakeClient(fail?: (input: SendMessageInput) => Error | undefined) {
  const sent: SendMessageInput[] = [];
  const client: WhatsAppClient & WhatsAppMediaClient = {
    sendMessage: (input) => {
      const error = fail?.(input);
      if (error) return Promise.reject(error);
      sent.push(input);
      return Promise.resolve({ messageId: `wamid.${randomUUID()}` });
    },
    downloadMedia: () => Promise.resolve({ data: new Uint8Array([1]), mimeType: 'image/jpeg' }),
    uploadMedia: () => Promise.resolve({ mediaId: 'media-subida' }),
  };
  return { client, sent };
}

async function connected(fixture: BookableFixture) {
  const phoneNumberId = await connectWhatsApp(db, fixture.tenantId);
  await saveCredential(db, credentialsKey, {
    tenantId: fixture.tenantId,
    kind: 'whatsapp',
    value: { accessToken: 'EAAG-token-del-negocio' },
  });
  return phoneNumberId;
}

async function book(fixture: BookableFixture, now: Date) {
  const booked = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: at('2026-10-05', '10:00'),
    actor: 'assistant',
    now,
  });
  if (!booked.ok) throw new Error(booked.reason);
  return booked.appointmentId;
}

describe('recordatorios y vencimientos, de punta a punta con el worker (H10)', () => {
  it('reserva confirmada → el día anterior a la misma hora sale el recordatorio con plantilla y botones', async () => {
    let now = at('2026-10-04', '09:00');
    const fixture = await createBookableFixture(db, { settings: { depositRequirement: 'never' } });
    const phoneNumberId = await connected(fixture);
    const { client, sent } = fakeClient();
    const worker = buildWorker({ db, logger, now: () => now, notifications: { client, credentialsKey } });
    onTestFinished(() => worker.stop());
    const appointmentId = await book(fixture, now);

    now = at('2026-10-04', '09:59');
    await worker.runOnce();
    expect(sent).toEqual([]);

    now = at('2026-10-04', '10:00');
    await worker.runOnce(); // el recordatorio deja el aviso
    await worker.runOnce(); // el aviso sale

    expect(sent).toEqual([
      {
        phoneNumberId,
        accessToken: 'EAAG-token-del-negocio',
        to: FIXTURE_CUSTOMER_PHONE,
        message: expect.objectContaining({
          type: 'template',
          name: 'recordatorio_turno',
          buttonPayloads: [
            `recordatorio:${appointmentId}:confirmar`,
            `recordatorio:${appointmentId}:reprogramar`,
            `recordatorio:${appointmentId}:cancelar`,
          ],
        }) as unknown,
      },
    ]);
  });

  it('reserva con seña sin pagar → al vencer el plazo el turno vence y la clienta recibe el aviso', async () => {
    let now = at('2026-10-04', '09:00');
    const fixture = await createBookableFixture(db);
    await connected(fixture);
    const { client, sent } = fakeClient();
    const worker = buildWorker({ db, logger, now: () => now, notifications: { client, credentialsKey } });
    onTestFinished(() => worker.stop());
    const appointmentId = await book(fixture, now);

    now = at('2026-10-04', '10:00');
    await worker.runOnce(); // vence y deja el aviso
    await worker.runOnce(); // el aviso sale

    expect(
      single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId))).status,
    ).toBe('EXPIRED');
    expect(sent.map((input) => [input.to, input.message])).toEqual([
      [
        FIXTURE_CUSTOMER_PHONE,
        {
          type: 'text',
          body:
            'Tu reserva de Esmaltado semipermanente del lunes 5/10 10:00 se liberó porque no nos llegó la seña a tiempo. ' +
            'Si querés otro horario, respondé este mensaje y te ayudamos.',
        },
      ],
    ]);
  });

  it('si la clienta no escribió en 24 horas, el aviso del vencimiento sale con su plantilla', async () => {
    let now = at('2026-10-04', '09:00');
    const fixture = await createBookableFixture(db);
    await connected(fixture);
    const { client, sent } = fakeClient(({ message }) =>
      message.type === 'template' ? undefined : new WhatsAppApiError('Re-engagement message', 400, 131047),
    );
    const worker = buildWorker({ db, logger, now: () => now, notifications: { client, credentialsKey } });
    onTestFinished(() => worker.stop());
    await book(fixture, now);

    now = at('2026-10-04', '10:00');
    await worker.runOnce();
    await worker.runOnce();

    expect(sent.map((input) => input.message)).toEqual([expect.objectContaining({ type: 'template', name: 'reserva_vencida' })]);
  });
});
