import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEPOSIT_REMINDER_DELAY_MS,
  MAX_DEPOSIT_REMINDERS,
  registerTransferReceipt,
  remindDepositReceipt,
} from '../../src/modules/conversation/deposit-receipts.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { notifications } from '../../src/modules/notifications/schema.js';
import { reviewDeposit, bookAppointment, changeAppointmentStatus } from '../../src/modules/scheduling/booking.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import { tenantSettings, type AttentionHoursBlock } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { noticeBody } from './support/notices.js';
import { createBookableFixture, createCustomer, single, type BookableFixture } from './support/fixtures.js';

/**
 * El comprobante lo reconoce el código, no el modelo (4.5, 5.3): una imagen es el comprobante si la
 * clienta tiene una sola seña por transferencia pendiente y su turno sigue pendiente de seña. Si la
 * dueña no contesta, se le vuelve a avisar a las 2 horas, hasta 3 veces, en su horario de atención.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = pino({ level: 'silent' });

afterAll(() => database.close());

const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
// El lunes 5/10/2026 se reserva el turno del martes 6/10; la dueña atiende de lunes a viernes de 9 a 18.
const BOOKED_AT = at('2026-10-05', '09:00');
const RECEIPT_AT = at('2026-10-05', '09:20');
const WEEKDAYS: AttentionHoursBlock[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' }));

async function setup(settings: Partial<typeof tenantSettings.$inferInsert> = {}) {
  return createBookableFixture(db, { settings: { humanAttentionHours: WEEKDAYS, ...settings } });
}

async function book(fixture: BookableFixture, start = at('2026-10-06', '10:00'), customerId = fixture.customerId) {
  const result = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start,
    actor: 'assistant',
    now: BOOKED_AT,
  });
  if (!result.ok || !result.deposit) throw new Error('La reserva de prueba no quedó pendiente de seña');
  return { appointmentId: result.appointmentId, depositId: result.deposit.id };
}

const register = (fixture: BookableFixture, mediaId = 'media-1', now = RECEIPT_AT, customerId = fixture.customerId) =>
  registerTransferReceipt(db, { tenantId: fixture.tenantId, customerId, mediaId, now });

const remind = (fixture: BookableFixture, depositId: string, now: Date) =>
  remindDepositReceipt({ db, logger, now: () => now }, { tenantId: fixture.tenantId, depositId });

const receiptNotices = (fixture: BookableFixture) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.tenantId, fixture.tenantId), eq(notifications.kind, 'deposit_receipt')))
    .orderBy(notifications.createdAt);

const reminderJob = async (fixture: BookableFixture, depositId: string) =>
  single(
    await db
      .select()
      .from(scheduledJobs)
      .where(
        and(
          eq(scheduledJobs.tenantId, fixture.tenantId),
          eq(scheduledJobs.kind, 'remind_deposit_receipt'),
          eq(scheduledJobs.key, depositId),
        ),
      ),
  );

const statusOf = async (appointmentId: string) =>
  single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId))).status;

describe('registerTransferReceipt: ¿la imagen es el comprobante?', () => {
  it('con una sola seña pendiente: registra el comprobante, avisa a la dueña con la imagen y programa el recordatorio', async () => {
    const f = await setup();
    const { appointmentId, depositId } = await book(f);

    const result = await register(f);

    expect(result).toMatchObject({ kind: 'registered', appointmentId, alreadyRegistered: false });
    expect(await statusOf(appointmentId)).toBe('DEPOSIT_REVIEW');
    const [notice] = await receiptNotices(f);
    expect(notice).toMatchObject({
      recipient: 'owner',
      depositId,
      appointmentId,
      receiptMediaId: 'media-1',
      message: {
        type: 'buttons',
        buttons: [
          { id: `aviso:${notice?.id ?? ''}:recibida`, title: 'Recibida' },
          { id: `aviso:${notice?.id ?? ''}:no_llego`, title: 'No llegó' },
        ],
      },
    });
    expect(noticeBody(notice?.message)).toContain('$5.400');
    // Por si la dueña no le escribió en 24 horas: la misma información con plantilla, con la imagen (H10).
    expect(notice?.template).toMatchObject({ name: 'aviso_comprobante', params: { monto: '$5.400' } });
    expect(notice?.template?.buttonPayloads).toHaveLength(2);
    expect(await reminderJob(f, depositId)).toMatchObject({
      status: 'pending',
      runAt: new Date(RECEIPT_AT.getTime() + DEPOSIT_REMINDER_DELAY_MS),
      payload: { depositId },
    });
  });

  it('la misma imagen otra vez (un reintento de la vuelta) no avisa de nuevo', async () => {
    const f = await setup();
    const { appointmentId } = await book(f);
    await register(f);

    expect(await register(f)).toMatchObject({ kind: 'registered', appointmentId, alreadyRegistered: true });

    expect(await receiptNotices(f)).toHaveLength(1);
  });

  it('sin seña pendiente no es un comprobante: es una imagen como cualquier otra', async () => {
    const f = await setup();

    expect(await register(f)).toEqual({ kind: 'not_receipt' });
  });

  it('con la seña en verificación, otra imagen no es un comprobante nuevo', async () => {
    const f = await setup();
    await book(f);
    await register(f);

    expect(await register(f, 'media-2')).toEqual({ kind: 'not_receipt' });
    expect(await receiptNotices(f)).toHaveLength(1);
  });

  it('un turno cancelado conserva la seña pendiente, pero ya no espera comprobante (4.5)', async () => {
    const f = await setup();
    const { appointmentId } = await book(f);
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId, to: 'CANCELLED_BY_CUSTOMER', actor: 'assistant', now: BOOKED_AT });

    expect(await register(f)).toEqual({ kind: 'not_receipt' });
  });

  it('se acepta pasado el plazo, mientras el turno siga pendiente de seña', async () => {
    const f = await setup();
    await book(f);

    expect(await register(f, 'media-1', at('2026-10-05', '15:00'))).toMatchObject({ kind: 'registered' });
  });

  it('con Mercado Pago no hay comprobante de transferencia', async () => {
    const f = await setup({ depositPaymentOptions: 'mercadopago' });
    await book(f);

    expect(await register(f)).toEqual({ kind: 'not_receipt' });
  });

  it('con dos señas pendientes no adivina cuál: no registra nada', async () => {
    const f = await setup();
    const first = await book(f);
    const second = await book(f, at('2026-10-07', '10:00'));

    expect(await register(f)).toEqual({ kind: 'several_pending' });

    expect(await statusOf(first.appointmentId)).toBe('PENDING_DEPOSIT');
    expect(await statusOf(second.appointmentId)).toBe('PENDING_DEPOSIT');
    expect(await receiptNotices(f)).toEqual([]);
  });

  it('solo mira las señas de esa clienta', async () => {
    const f = await setup();
    const other = await createCustomer(db, f.tenantId);
    await book(f, at('2026-10-06', '10:00'), other);

    expect(await register(f)).toEqual({ kind: 'not_receipt' });
  });

  it('el recordatorio que caería fuera del horario de atención sale al próximo inicio', async () => {
    const f = await setup();
    const { depositId } = await book(f);

    await register(f, 'media-1', at('2026-10-05', '17:00'));

    expect((await reminderJob(f, depositId)).runAt).toEqual(at('2026-10-06', '09:00'));
  });
});

describe('remindDepositReceipt: la dueña no contestó (4.5)', () => {
  async function inReview() {
    const f = await setup();
    const booked = await book(f);
    await register(f);
    return { f, ...booked };
  }

  it('le vuelve a avisar, con el mismo comprobante, y programa el siguiente', async () => {
    const { f, depositId } = await inReview();
    const now = at('2026-10-05', '11:20');

    expect(await remind(f, depositId, now)).toBe('reminded');

    const notices = await receiptNotices(f);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ receiptMediaId: 'media-1', depositId });
    expect(noticeBody(notices[1]?.message)).toMatch(/^\*Recordatorio\*/);
    expect(notices[1]?.template).toMatchObject({ name: 'aviso_comprobante' });
    expect((await reminderJob(f, depositId)).rerunAt ?? (await reminderJob(f, depositId)).runAt).toEqual(
      new Date(now.getTime() + DEPOSIT_REMINDER_DELAY_MS),
    );
  });

  it(`después de ${String(MAX_DEPOSIT_REMINDERS)} recordatorios no avisa más`, async () => {
    const { f, depositId } = await inReview();
    for (const time of ['11:20', '13:20', '15:20']) {
      expect(await remind(f, depositId, at('2026-10-05', time))).toBe('reminded');
    }

    expect(await remind(f, depositId, at('2026-10-05', '17:20'))).toBe('exhausted');

    expect(await receiptNotices(f)).toHaveLength(1 + MAX_DEPOSIT_REMINDERS);
  });

  it('si la dueña ya contestó, no avisa', async () => {
    const { f, depositId } = await inReview();
    await reviewDeposit(db, { tenantId: f.tenantId, depositId, decision: 'approved', actor: 'owner', now: at('2026-10-05', '10:00') });

    expect(await remind(f, depositId, at('2026-10-05', '11:20'))).toBe('not_needed');

    expect(await receiptNotices(f)).toHaveLength(1);
  });

  it('fuera del horario de atención no avisa: se corre al próximo inicio', async () => {
    const { f, depositId } = await inReview();

    expect(await remind(f, depositId, at('2026-10-05', '19:00'))).toBe('deferred');

    expect(await receiptNotices(f)).toHaveLength(1);
    const job = await reminderJob(f, depositId);
    expect(job.rerunAt ?? job.runAt).toEqual(at('2026-10-06', '09:00'));
  });
});
