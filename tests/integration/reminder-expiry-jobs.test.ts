import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { businessInfo } from '../../src/modules/catalog/schema.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { sendAppointmentReminder } from '../../src/modules/notifications/appointment-reminders.js';
import { runReservationExpiry } from '../../src/modules/notifications/reservation-expiry.js';
import { notifications } from '../../src/modules/notifications/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import type { ReminderPayload } from '../../src/modules/scheduling/appointment-jobs.js';
import {
  bookAppointment,
  changeAppointmentStatus,
  rescheduleAppointment,
  submitTransferReceipt,
} from '../../src/modules/scheduling/booking.js';
import { tenants, tenantSettings } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, createCustomer, type BookableFixture } from './support/fixtures.js';
import { noticeBody } from './support/notices.js';

/**
 * Las tareas de H10 (4.5, 4.7): antes de actuar verifican, con el turno bloqueado, que la acción
 * siga siendo válida (regla 7). Dejan un aviso para la clienta: lo envía `send_notification`.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = pino({ level: 'silent' });

afterAll(() => database.close());

// Octubre de 2026 en Mendoza: el 4 es domingo y el 5 lunes.
const at = (date: string, time: string) => localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const SUNDAY_9 = at('2026-10-04', '09:00');
const MONDAY_10 = at('2026-10-05', '10:00');
const REMINDER_TIME = at('2026-10-04', '10:00');

async function book(fixture: BookableFixture, options: { customerId?: string; now?: Date; start?: Date } = {}) {
  const result = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: options.customerId ?? fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: options.start ?? MONDAY_10,
    actor: 'assistant',
    now: options.now ?? SUNDAY_9,
  });
  if (!result.ok) throw new Error(`No se pudo reservar: ${result.reason}`);
  return result;
}

const confirmedFixture = () => createBookableFixture(db, { settings: { depositRequirement: 'never' } });

const dayBefore = (appointmentId: string, start = MONDAY_10): ReminderPayload => ({
  appointmentId,
  reminder: 'day_before',
  appointmentStart: start.toISOString(),
});

function remind(fixture: BookableFixture, payload: ReminderPayload, now = REMINDER_TIME) {
  return sendAppointmentReminder({ db, logger, now: () => now }, { tenantId: fixture.tenantId, payload });
}

function expire(fixture: BookableFixture, appointmentId: string, now = at('2026-10-04', '10:00')) {
  return runReservationExpiry({ db, logger, now: () => now }, { tenantId: fixture.tenantId, appointmentId });
}

async function noticesOf(appointmentId: string) {
  return db.select().from(notifications).where(eq(notifications.appointmentId, appointmentId));
}

async function sendJobFor(tenantId: string, notificationId: string) {
  return db
    .select({ status: scheduledJobs.status })
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.kind, 'send_notification'), eq(scheduledJobs.key, notificationId)));
}

describe('send_appointment_reminder: el recordatorio del día anterior (4.7)', () => {
  it('deja el aviso a la clienta con la plantilla y los tres botones, y programa su envío', async () => {
    const fixture = await confirmedFixture();
    const { appointmentId } = await book(fixture);

    expect(await remind(fixture, dayBefore(appointmentId))).toBe('queued');

    const [notice] = await noticesOf(appointmentId);
    expect(notice).toMatchObject({
      recipient: 'customer',
      kind: 'appointment_reminder',
      customerId: fixture.customerId,
      appointmentStart: MONDAY_10,
      status: 'pending',
      template: null,
      message: {
        type: 'template',
        name: 'recordatorio_turno',
        params: { servicio: 'Esmaltado semipermanente', profesional: 'Mica', fecha_hora: 'lunes 5/10 10:00' },
        buttonPayloads: [
          `recordatorio:${appointmentId}:confirmar`,
          `recordatorio:${appointmentId}:reprogramar`,
          `recordatorio:${appointmentId}:cancelar`,
        ],
      },
    });
    expect(await sendJobFor(fixture.tenantId, notice?.id ?? '')).toEqual([{ status: 'pending' }]);
  });

  it('si la tarea corre dos veces, el recordatorio sale una sola vez (regla 7)', async () => {
    const fixture = await confirmedFixture();
    const { appointmentId } = await book(fixture);
    await remind(fixture, dayBefore(appointmentId));

    expect(await remind(fixture, dayBefore(appointmentId))).toBe('already_queued');

    expect(await noticesOf(appointmentId)).toHaveLength(1);
  });

  it('un turno con la seña en verificación también lo recibe: la clienta ya pagó', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, deposit } = await book(fixture);
    await submitTransferReceipt(db, { tenantId: fixture.tenantId, depositId: deposit?.id ?? '', mediaId: 'img-1', now: SUNDAY_9 });

    expect(await remind(fixture, dayBefore(appointmentId))).toBe('queued');
  });

  it('un turno pendiente de seña no lo recibe', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await book(fixture);

    expect(await remind(fixture, dayBefore(appointmentId), at('2026-10-04', '09:30'))).toBe('not_reminded');
    expect(await noticesOf(appointmentId)).toEqual([]);
  });

  it('un turno cancelado no lo recibe', async () => {
    const fixture = await confirmedFixture();
    const { appointmentId } = await book(fixture);
    await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: SUNDAY_9,
    });

    expect(await remind(fixture, dayBefore(appointmentId))).toBe('not_reminded');
  });

  it('si el turno se movió, la tarea calculada para el horario anterior no envía nada', async () => {
    const fixture = await confirmedFixture();
    const { appointmentId } = await book(fixture, { start: at('2026-10-06', '10:00') });
    await rescheduleAppointment(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      newStart: MONDAY_10,
      actor: 'assistant',
      now: at('2026-10-04', '18:00'),
    });

    expect(await remind(fixture, dayBefore(appointmentId, at('2026-10-06', '10:00')), at('2026-10-05', '10:00'))).toBe('stale');
    expect(await noticesOf(appointmentId)).toEqual([]);
  });

  it('una tarea atrasada que corre fuera del horario de envío no manda nada', async () => {
    const fixture = await confirmedFixture();
    const { appointmentId } = await book(fixture);

    expect(await remind(fixture, dayBefore(appointmentId), at('2026-10-04', '23:30'))).toBe('late');
    expect(await noticesOf(appointmentId)).toEqual([]);
  });

  it('un turno que ya empezó no recibe recordatorio', async () => {
    const fixture = await confirmedFixture();
    const { appointmentId } = await book(fixture);

    expect(await remind(fixture, dayBefore(appointmentId), at('2026-10-05', '10:30'))).toBe('started');
  });

  it('un negocio pausado no manda recordatorios', async () => {
    const fixture = await confirmedFixture();
    const { appointmentId } = await book(fixture);
    await db.update(tenants).set({ status: 'paused' }).where(eq(tenants.id, fixture.tenantId));

    expect(await remind(fixture, dayBefore(appointmentId))).toBe('inactive');
  });

  it('el turno de otro negocio no se encuentra', async () => {
    const fixture = await confirmedFixture();
    const other = await confirmedFixture();
    const { appointmentId } = await book(fixture);

    expect(await remind(other, dayBefore(appointmentId))).toBe('not_found');
  });
});

describe('send_appointment_reminder: el recordatorio corto (4.7)', () => {
  const MONDAY_12 = at('2026-10-05', '12:00');
  const short = (appointmentId: string): ReminderPayload => ({
    appointmentId,
    reminder: 'short',
    appointmentStart: MONDAY_12.toISOString(),
  });

  async function withAddress() {
    const fixture = await createBookableFixture(db, { settings: { depositRequirement: 'never', shortReminderEnabled: true } });
    await db.insert(businessInfo).values({ tenantId: fixture.tenantId, topic: 'address', content: 'San Martín 1234\nPlanta alta' });
    return fixture;
  }

  it('lleva la hora y la dirección del negocio', async () => {
    const fixture = await withAddress();
    const { appointmentId } = await book(fixture, { start: MONDAY_12 });

    expect(await remind(fixture, short(appointmentId), at('2026-10-05', '10:00'))).toBe('queued');

    const [notice] = await noticesOf(appointmentId);
    expect(notice).toMatchObject({
      kind: 'appointment_short_reminder',
      message: {
        name: 'recordatorio_turno_corto',
        params: { hora: '12:00', servicio: 'Esmaltado semipermanente', direccion: 'San Martín 1234 Planta alta' },
      },
    });
  });

  it('si el negocio lo desactivó después de programarlo, no sale', async () => {
    const fixture = await withAddress();
    const { appointmentId } = await book(fixture, { start: MONDAY_12 });
    await db.update(tenantSettings).set({ shortReminderEnabled: false }).where(eq(tenantSettings.tenantId, fixture.tenantId));

    expect(await remind(fixture, short(appointmentId), at('2026-10-05', '10:00'))).toBe('disabled');
  });
});

describe('expire_reservation: el vencimiento de la reserva provisoria (4.5)', () => {
  it('vence el turno y deja el aviso a la clienta, con el mismo texto libre y con plantilla', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, deposit } = await book(fixture);

    expect(await expire(fixture, appointmentId)).toBe('expired');

    expect((await db.select().from(deposits).where(eq(deposits.id, deposit?.id ?? '')))[0]?.status).toBe('expired');
    const [notice] = await noticesOf(appointmentId);
    expect(notice).toMatchObject({
      recipient: 'customer',
      kind: 'reservation_expired',
      appointmentStart: MONDAY_10,
      template: { name: 'reserva_vencida', params: { servicio: 'Esmaltado semipermanente', fecha_hora: 'lunes 5/10 10:00' } },
    });
    expect(noticeBody(notice?.message)).toMatch(/se liberó porque no nos llegó la seña a tiempo/);
  });

  it('si la tarea corre dos veces, el aviso sale una sola vez', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await book(fixture);
    await expire(fixture, appointmentId);

    expect(await expire(fixture, appointmentId)).toBe('already_expired');

    expect(await noticesOf(appointmentId)).toHaveLength(1);
  });

  it('si lo venció una reserva que pisaba su horario, igual le avisa a la clienta, una vez', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await book(fixture);
    await book(fixture, { customerId: await createCustomer(db, fixture.tenantId), now: at('2026-10-04', '10:05') });

    expect(await expire(fixture, appointmentId, at('2026-10-04', '10:06'))).toBe('already_expired');

    expect((await noticesOf(appointmentId)).map((notice) => notice.kind)).toEqual(['reservation_expired']);
  });

  it('una seña en verificación no vence ni avisa (4.4)', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, deposit } = await book(fixture);
    await submitTransferReceipt(db, { tenantId: fixture.tenantId, depositId: deposit?.id ?? '', mediaId: 'img-2', now: SUNDAY_9 });

    expect(await expire(fixture, appointmentId)).toBe('not_pending');

    expect((await noticesOf(appointmentId)).some((notice) => notice.kind === 'reservation_expired')).toBe(false);
  });

  it('antes del plazo no hace nada', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await book(fixture);

    expect(await expire(fixture, appointmentId, at('2026-10-04', '09:30'))).toBe('not_due');
    expect(await noticesOf(appointmentId)).toEqual([]);
  });
});
