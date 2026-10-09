import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { conversations, handoffs } from '../../src/modules/conversation/schema.js';
import { choiceIds } from '../../src/modules/conversation/tools/choice-ids.js';
import { rescheduleAppointmentTool } from '../../src/modules/conversation/tools/reschedule-appointment.js';
import { runTool } from '../../src/modules/conversation/tools/tool.js';
import { customers } from '../../src/modules/customers/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { bookAppointment, changeAppointmentStatus } from '../../src/modules/scheduling/booking.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, toolContext, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

type Fixture = CatalogFixture & { conversationId: string };

/** Un negocio con atención de lunes a viernes de 9 a 18 y la conversación de la clienta. */
async function setup(settings: Parameters<typeof createCatalogFixture>[1] = {}): Promise<Fixture> {
  const catalog = await createCatalogFixture(db, {
    settings: {
      humanAttentionHours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })),
      ...settings.settings,
    },
  });
  const { id: conversationId } = single(
    await db
      .insert(conversations)
      .values({ tenantId: catalog.tenantId, customerId: catalog.customerId })
      .returning({ id: conversations.id }),
  );
  return { ...catalog, conversationId };
}

// Los turnos se reservan el domingo 4/10/2026 a las 9:00; el turno de las pruebas es el martes 6/10 a las 10:00.
const BOOKED_AT = at('2026-10-04', '09:00');
const TUESDAY_10 = at('2026-10-06', '10:00');
const WEDNESDAY_10 = at('2026-10-07', '10:00');
const THURSDAY_10 = at('2026-10-08', '10:00');

async function book(f: Fixture, start = TUESDAY_10, customerId = f.customerId, serviceId = f.semi) {
  const result = await bookAppointment(db, {
    tenantId: f.tenantId,
    customerId,
    serviceId,
    professionalId: f.mica,
    start,
    actor: 'assistant',
    now: BOOKED_AT,
  });
  if (!result.ok) throw new Error(`No se pudo reservar: ${result.reason}`);
  return result.appointmentId;
}

/** La seña ya está paga (pasó el comprobante y la dueña lo aprobó). */
async function payDeposit(f: Fixture, appointmentId: string, status: 'approved' | 'in_review' = 'approved') {
  await changeAppointmentStatus(db, {
    tenantId: f.tenantId,
    appointmentId,
    to: status === 'approved' ? 'CONFIRMED' : 'DEPOSIT_REVIEW',
    actor: status === 'approved' ? 'owner' : 'assistant',
    now: BOOKED_AT,
  });
  await db
    .update(deposits)
    .set({ status, ...(status === 'in_review' ? { receiptMediaId: 'media-1' } : {}) })
    .where(eq(deposits.appointmentId, appointmentId));
}

const slotId = (f: Fixture, start: Date, professionalId = f.mica, serviceId = f.semi) =>
  choiceIds.slot(serviceId, professionalId, start);

const reschedule = (f: Fixture, input: unknown, now = at('2026-10-04', '09:30')) =>
  runTool(rescheduleAppointmentTool, input, toolContext(db, f, { conversationId: f.conversationId, now }));

const rowOf = async (appointmentId: string) =>
  single(await db.select().from(appointments).where(eq(appointments.id, appointmentId)));

const reschedulesOf = async (appointmentId: string) =>
  (await db.select().from(appointmentEvents).where(eq(appointmentEvents.appointmentId, appointmentId))).filter(
    (event) => event.kind === 'rescheduled',
  );

const handoffsOf = (f: Fixture) =>
  db.select().from(handoffs).where(and(eq(handoffs.tenantId, f.tenantId), eq(handoffs.conversationId, f.conversationId)));

describe('reprogramar_turno: el camino feliz', () => {
  it('mueve el turno al horario nuevo, sin cambiar el estado, y registra el evento del asistente con el horario anterior', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await reschedule(f, { turno_id: `turno:${id}`, horario_id: slotId(f, WEDNESDAY_10) });

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({
      reprogramado: true,
      turno: { turnoId: `turno:${id}`, servicio: 'Esmaltado semipermanente', profesional: 'Mica', fecha: 'miércoles 7/10 10:00' },
    });
    expect(result.options).toEqual([]);
    const row = await rowOf(id);
    expect(row.status).toBe('PENDING_DEPOSIT');
    expect(row.timeRange.start).toEqual(WEDNESDAY_10);
    expect(await reschedulesOf(id)).toEqual([
      expect.objectContaining({
        actor: 'assistant',
        fromStatus: 'PENDING_DEPOSIT',
        toStatus: 'PENDING_DEPOSIT',
        previousTimeRange: { start: TUESDAY_10, end: new Date(TUESDAY_10.getTime() + 70 * 60_000) },
      }),
    ]);
    expect(await handoffsOf(f)).toEqual([]);
  });

  it('acepta el uuid del turno sin el prefijo y un horario que se pisa con el propio turno', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, at('2026-10-06', '10:15')) });

    expect(result.content).toMatchObject({ reprogramado: true, turno: { fecha: 'martes 6/10 10:15' } });
  });

  it('con la seña paga, la primera reprogramación la conserva y se lo dice al modelo', async () => {
    const f = await setup();
    const id = await book(f);
    await payDeposit(f, id);

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });

    expect(result.content).toMatchObject({ reprogramado: true, senaConservada: true, turno: { estado: 'confirmado' } });
    expect((await rowOf(id)).timeRange.start).toEqual(WEDNESDAY_10);
  });

  it('sin seña paga no hay límite de reprogramaciones', async () => {
    const f = await setup();
    const id = await book(f);

    await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });
    const second = await reschedule(f, { turno_id: id, horario_id: slotId(f, THURSDAY_10) });

    expect(second.content).toMatchObject({ reprogramado: true });
    expect(await reschedulesOf(id)).toHaveLength(2);
    expect(await handoffsOf(f)).toEqual([]);
  });
});

describe('reprogramar_turno: es idempotente', () => {
  it('si el turno ya está en ese horario responde que está, sin evento nuevo', async () => {
    const f = await setup();
    const id = await book(f);
    await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });

    const again = await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });

    expect(again.isError).toBeFalsy();
    expect(again.content).toMatchObject({ reprogramado: true, yaEstaba: true, turno: { fecha: 'miércoles 7/10 10:00' } });
    expect(await reschedulesOf(id)).toHaveLength(1);
  });

  it('un reintento con la seña paga y la reprogramación ya usada no deriva', async () => {
    const f = await setup();
    const id = await book(f);
    await payDeposit(f, id);
    await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });

    const again = await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });

    expect(again.content).toMatchObject({ reprogramado: true, yaEstaba: true });
    expect(await handoffsOf(f)).toEqual([]);
  });
});

describe('reprogramar_turno: si no corresponde, no toca el turno y deriva sola (4.6)', () => {
  it('con la seña paga y la reprogramación que la conserva ya usada: deriva con la política', async () => {
    const f = await setup();
    const id = await book(f);
    await payDeposit(f, id);
    await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, THURSDAY_10) });

    expect(result.isError).toBeFalsy();
    expect(result.options).toEqual([]);
    expect(result.content).toMatchObject({
      reprogramado: false,
      derivada: true,
      motivo: 'ya usaste la reprogramación que conserva la seña',
      politica: 'con la seña paga se puede reprogramar 1 vez conservando la seña',
      // Es domingo: la atención vuelve el lunes a las 9:00.
      cuando: 'el lunes 5/10 a las 9:00',
    });
    expect((await rowOf(id)).timeRange.start).toEqual(WEDNESDAY_10);
    expect(await reschedulesOf(id)).toHaveLength(1);
    expect(await handoffsOf(f)).toEqual([
      expect.objectContaining({
        reason: 'policy_exception',
        status: 'open',
        summary: 'Pide reprogramar de nuevo el turno del miércoles 7/10 10:00: ya usó la reprogramación que conserva la seña',
      }),
    ]);
  });

  it('una seña en verificación cuenta como seña paga', async () => {
    const f = await setup();
    const id = await book(f);
    await payDeposit(f, id, 'in_review');
    await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, THURSDAY_10) });

    expect(result.content).toMatchObject({ derivada: true });
  });

  it('con 2 reprogramaciones que conservan la seña, la segunda todavía corresponde y la tercera deriva', async () => {
    const f = await setup({ settings: { reschedulesKeepingDeposit: 2 } });
    const id = await book(f);
    await payDeposit(f, id);

    const first = await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });
    const second = await reschedule(f, { turno_id: id, horario_id: slotId(f, THURSDAY_10) });
    const third = await reschedule(f, { turno_id: id, horario_id: slotId(f, at('2026-10-09', '10:00')) });

    expect(first.content).toMatchObject({ reprogramado: true });
    expect(second.content).toMatchObject({ reprogramado: true });
    expect(third.content).toMatchObject({ derivada: true, motivo: 'ya usaste las 2 reprogramaciones que conservan la seña' });
  });

  it('fuera de plazo: faltan menos horas que el plazo', async () => {
    const f = await setup({ settings: { depositRequirement: 'never' } });
    const id = await book(f);

    // Lunes 5/10 a las 11:00: faltan 23 horas para el martes a las 10:00.
    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) }, at('2026-10-05', '11:00'));

    expect(result.content).toMatchObject({
      reprogramado: false,
      derivada: true,
      motivo: 'faltan menos de 24 horas para el turno',
      politica: 'se reprograma sin costo con al menos 24 horas de anticipación',
    });
    expect((await rowOf(id)).timeRange.start).toEqual(TUESDAY_10);
    expect(await handoffsOf(f)).toEqual([
      expect.objectContaining({ summary: 'Pide reprogramar fuera de plazo el turno del martes 6/10 10:00' }),
    ]);
  });

  it('justo 24 horas antes todavía corresponde', async () => {
    const f = await setup({ settings: { depositRequirement: 'never' } });
    const id = await book(f);

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) }, at('2026-10-05', '10:00'));

    expect(result.content).toMatchObject({ reprogramado: true });
  });

  it('un turno que ya empezó no se reprograma', async () => {
    const f = await setup({ settings: { depositRequirement: 'never' } });
    const id = await book(f);

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, THURSDAY_10) }, at('2026-10-06', '10:30'));

    expect(result.content).toMatchObject({ derivada: true, motivo: 'el turno ya empezó' });
    expect((await rowOf(id)).timeRange.start).toEqual(TUESDAY_10);
  });

  it('derivar dos veces en la misma pausa deja una sola derivación', async () => {
    const f = await setup({ settings: { depositRequirement: 'never' } });
    const id = await book(f);
    const late = at('2026-10-05', '11:00');

    await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) }, late);
    await reschedule(f, { turno_id: id, horario_id: slotId(f, THURSDAY_10) }, late);

    expect(await handoffsOf(f)).toHaveLength(1);
  });
});

describe('reprogramar_turno: solo el mismo servicio con la misma profesional', () => {
  it('otra profesional: no reprograma ni deriva, y le dice al modelo qué consultar', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10, f.sofi) });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reprogramado: false, motivo: 'otro_servicio_o_profesional' });
    expect(JSON.stringify(result.content)).toContain(`servicio_id=${f.semi}`);
    expect(JSON.stringify(result.content)).toContain(`profesional_id=${f.mica}`);
    expect(JSON.stringify(result.content)).toMatch(/derivar_a_persona/);
    expect((await rowOf(id)).timeRange.start).toEqual(TUESDAY_10);
    expect(await handoffsOf(f)).toEqual([]);
  });

  it('otro servicio con la misma profesional tampoco', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10, f.mica, f.sculpted) });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ motivo: 'otro_servicio_o_profesional' });
  });
});

describe('reprogramar_turno: rechazos del horario nuevo', () => {
  it('el horario nuevo se acaba de ocupar: el turno queda donde estaba', async () => {
    const f = await setup();
    const id = await book(f);
    const other = single(
      await db.insert(customers).values({ tenantId: f.tenantId, phone: '+5492614222222', name: 'Otra' }).returning({ id: customers.id }),
    ).id;
    await book(f, WEDNESDAY_10, other);

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({ reprogramado: false, motivo: 'horario_ocupado' });
    expect(JSON.stringify(result.content)).toMatch(/consultar_disponibilidad/);
    expect((await rowOf(id)).timeRange.start).toEqual(TUESDAY_10);
  });

  it('un horario que no es válido (domingo)', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, at('2026-10-11', '10:00')) });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reprogramado: false, motivo: 'horario_no_valido' });
    expect((await rowOf(id)).timeRange.start).toEqual(TUESDAY_10);
  });
});

describe('reprogramar_turno: solo los turnos de esta clienta (regla 2)', () => {
  it('el turno de otra clienta del mismo negocio no se ve ni se mueve', async () => {
    const f = await setup();
    const other = single(
      await db.insert(customers).values({ tenantId: f.tenantId, phone: '+5492614111111', name: 'Otra' }).returning({ id: customers.id }),
    ).id;
    const theirs = await book(f, TUESDAY_10, other);

    const result = await reschedule(f, { turno_id: `turno:${theirs}`, horario_id: slotId(f, WEDNESDAY_10) });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reprogramado: false, motivo: 'turno_no_encontrado' });
    expect((await rowOf(theirs)).timeRange.start).toEqual(TUESDAY_10);
    expect(await handoffsOf(f)).toEqual([]);
  });

  it('el turno de otro negocio tampoco', async () => {
    const f = await setup();
    const other = await setup();
    const theirs = await book(other);

    const result = await reschedule(f, { turno_id: theirs, horario_id: slotId(other, WEDNESDAY_10) });

    expect(result.isError).toBe(true);
    expect((await rowOf(theirs)).timeRange.start).toEqual(TUESDAY_10);
  });

  it('un turno cancelado no se reprograma', async () => {
    const f = await setup();
    const id = await book(f);
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId: id, to: 'CANCELLED_BY_CUSTOMER', actor: 'assistant', now: BOOKED_AT });

    const result = await reschedule(f, { turno_id: id, horario_id: slotId(f, WEDNESDAY_10) });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ motivo: 'turno_no_activo' });
    expect((await rowOf(id)).timeRange.start).toEqual(TUESDAY_10);
  });

  it('un turno_id que no es un turno no reprograma nada', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await reschedule(f, { turno_id: 'el del martes', horario_id: slotId(f, WEDNESDAY_10) });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reprogramado: false, motivo: 'id_de_turno_invalido' });
    expect((await rowOf(id)).timeRange.start).toEqual(TUESDAY_10);
  });

  it('un horario_id que no es un horario no reprograma nada', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await reschedule(f, { turno_id: id, horario_id: choiceIds.service(f.semi) });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reprogramado: false, motivo: 'id_de_horario_invalido' });
    expect((await rowOf(id)).timeRange.start).toEqual(TUESDAY_10);
  });
});
