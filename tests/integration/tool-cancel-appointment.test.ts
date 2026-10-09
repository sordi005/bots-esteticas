import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { conversations, handoffs } from '../../src/modules/conversation/schema.js';
import { cancelAppointmentTool } from '../../src/modules/conversation/tools/cancel-appointment.js';
import { choiceIds } from '../../src/modules/conversation/tools/choice-ids.js';
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

async function book(f: Fixture, start = TUESDAY_10, customerId = f.customerId) {
  const result = await bookAppointment(db, {
    tenantId: f.tenantId,
    customerId,
    serviceId: f.semi,
    professionalId: f.mica,
    start,
    actor: 'assistant',
    now: BOOKED_AT,
  });
  if (!result.ok) throw new Error(`No se pudo reservar: ${result.reason}`);
  return result.appointmentId;
}

const cancel = (f: Fixture, input: unknown, now = at('2026-10-04', '09:30')) =>
  runTool(cancelAppointmentTool, input, toolContext(db, f, { conversationId: f.conversationId, now }));

const statusOf = async (appointmentId: string) =>
  single(await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId))).status;

const eventsOf = (appointmentId: string) =>
  db.select().from(appointmentEvents).where(eq(appointmentEvents.appointmentId, appointmentId));

const handoffsOf = (f: Fixture) =>
  db.select().from(handoffs).where(and(eq(handoffs.tenantId, f.tenantId), eq(handoffs.conversationId, f.conversationId)));

describe('cancelar_turno: confirmada=false pide la confirmación sin cambiar nada', () => {
  it('devuelve el resumen del turno y ofrece el botón "Sí, cancelar" con el id del turno', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await cancel(f, { turno_id: `turno:${id}`, confirmada: false });

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({
      cancelado: false,
      faltaConfirmar: true,
      turno: { turnoId: `turno:${id}`, servicio: 'Esmaltado semipermanente', profesional: 'Mica', fecha: 'martes 6/10 10:00' },
    });
    expect(result.options).toEqual([{ id: choiceIds.cancel(id), title: 'Sí, cancelar' }]);
    expect(await statusOf(id)).toBe('PENDING_DEPOSIT');
    expect(await eventsOf(id)).toHaveLength(1);
  });

  it('acepta el uuid del turno sin el prefijo', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await cancel(f, { turno_id: id, confirmada: false });

    expect(result.options).toEqual([{ id: choiceIds.cancel(id), title: 'Sí, cancelar' }]);
  });
});

describe('cancelar_turno: confirmada=true cancela', () => {
  it('pasa el turno a cancelado por la clienta, con el evento del asistente y el motivo', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await cancel(f, { turno_id: `turno:${id}`, confirmada: true });

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({
      cancelado: true,
      turno: { turnoId: `turno:${id}`, fecha: 'martes 6/10 10:00', estado: 'cancelado' },
    });
    expect(result.options).toEqual([]);
    expect(await statusOf(id)).toBe('CANCELLED_BY_CUSTOMER');
    const cancellation = (await eventsOf(id)).find((event) => event.toStatus === 'CANCELLED_BY_CUSTOMER');
    expect(cancellation).toMatchObject({ fromStatus: 'PENDING_DEPOSIT', actor: 'assistant' });
    expect(cancellation?.reason).toMatch(/clienta/i);
    expect(await handoffsOf(f)).toEqual([]);
  });

  it('libera el horario: otra clienta puede reservarlo', async () => {
    const f = await setup();
    const id = await book(f);
    const other = single(
      await db.insert(customers).values({ tenantId: f.tenantId, phone: '+5492614444444', name: 'Otra' }).returning({ id: customers.id }),
    ).id;

    await cancel(f, { turno_id: id, confirmada: true });

    await expect(book(f, TUESDAY_10, other)).resolves.toEqual(expect.any(String));
  });

  it('cancela también un turno confirmado y uno con la seña en verificación', async () => {
    const f = await setup();
    const confirmed = await book(f);
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId: confirmed, to: 'CONFIRMED', actor: 'owner', now: BOOKED_AT });
    const review = await book(f, at('2026-10-07', '10:00'));
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId: review, to: 'DEPOSIT_REVIEW', actor: 'assistant', now: BOOKED_AT });

    await cancel(f, { turno_id: confirmed, confirmada: true });
    await cancel(f, { turno_id: review, confirmada: true });

    expect(await statusOf(confirmed)).toBe('CANCELLED_BY_CUSTOMER');
    expect(await statusOf(review)).toBe('CANCELLED_BY_CUSTOMER');
  });

  it('si la seña ya estaba paga, le avisa al modelo que no hay devolución automática ni que prometer nada', async () => {
    const f = await setup();
    const id = await book(f);
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId: id, to: 'CONFIRMED', actor: 'owner', now: BOOKED_AT });
    await db.update(deposits).set({ status: 'approved' }).where(eq(deposits.appointmentId, id));

    const result = await cancel(f, { turno_id: id, confirmada: true });

    expect(result.content).toMatchObject({ cancelado: true });
    expect(JSON.stringify(result.content)).toMatch(/seña[^"]*no se devuelve[^"]*automáticamente[^"]*no prometas/i);
  });

  it('dos confirmaciones a la vez cancelan una sola vez y las dos dicen que quedó cancelado', async () => {
    const f = await setup();
    const id = await book(f);

    const [a, b] = await Promise.all([
      cancel(f, { turno_id: id, confirmada: true }),
      cancel(f, { turno_id: id, confirmada: true }),
    ]);

    expect(a.content).toMatchObject({ cancelado: true });
    expect(b.content).toMatchObject({ cancelado: true });
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    const cancellations = (await eventsOf(id)).filter((event) => event.toStatus === 'CANCELLED_BY_CUSTOMER');
    expect(cancellations).toHaveLength(1);
  });
});

describe('cancelar_turno: un turno que ya estaba cancelado o que no ocupa horario', () => {
  it('uno que ya estaba cancelado por la clienta responde que ya lo está, sin error ni evento nuevo', async () => {
    const f = await setup();
    const id = await book(f);
    await cancel(f, { turno_id: id, confirmada: true });
    const eventsBefore = (await eventsOf(id)).length;

    const result = await cancel(f, { turno_id: id, confirmada: false });

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({ cancelado: true, yaEstabaCancelado: true });
    expect(result.options).toEqual([]);
    expect(await eventsOf(id)).toHaveLength(eventsBefore);
  });

  it('uno cancelado por el negocio no se puede cancelar: no ocupa horario', async () => {
    const f = await setup();
    const id = await book(f);
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId: id, to: 'CANCELLED_BY_BUSINESS', actor: 'owner', now: BOOKED_AT });

    const result = await cancel(f, { turno_id: id, confirmada: true });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ cancelado: false });
    expect(JSON.stringify(result.content)).toMatch(/ya no está activo/);
    expect(await statusOf(id)).toBe('CANCELLED_BY_BUSINESS');
  });

  it('una reserva con la seña vencida (aunque la tarea no la haya vencido) tampoco ocupa horario', async () => {
    const f = await setup();
    const id = await book(f);

    // La seña vencía a las 10:00 del domingo.
    const result = await cancel(f, { turno_id: id, confirmada: true }, at('2026-10-04', '11:00'));

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/vencido por falta de seña/);
    expect(await statusOf(id)).toBe('PENDING_DEPOSIT');
  });
});

describe('cancelar_turno: fuera de plazo no toca el turno y deriva sola (4.6)', () => {
  // Lunes 5/10 a las 11:00: faltan 23 horas para el martes a las 10:00, y el plazo es de 24.
  const LATE = at('2026-10-05', '11:00');

  it('deriva con motivo excepción y un resumen corto, y devuelve la política y cuándo responde una persona', async () => {
    const f = await setup({ settings: { depositRequirement: 'never' } });
    const id = await book(f);

    const result = await cancel(f, { turno_id: id, confirmada: true }, LATE);

    expect(result.isError).toBeFalsy();
    expect(result.options).toEqual([]);
    expect(result.content).toMatchObject({
      cancelado: false,
      derivada: true,
      motivo: 'faltan menos de 24 horas para el turno',
      politica: 'se cancela sin costo con al menos 24 horas de anticipación',
      cuando: 'en este horario',
    });
    expect(await statusOf(id)).toBe('CONFIRMED');
    expect(await eventsOf(id)).toHaveLength(1);
    expect(await handoffsOf(f)).toEqual([
      expect.objectContaining({
        reason: 'policy_exception',
        status: 'open',
        summary: 'Pide cancelar fuera de plazo el turno del martes 6/10 10:00',
      }),
    ]);
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, f.conversationId));
    expect(conversation?.assistantStatus).toBe('paused');
  });

  it('con confirmada=false también deriva: no ofrece un botón que no podría cumplir', async () => {
    const f = await setup({ settings: { depositRequirement: 'never' } });
    const id = await book(f);

    const result = await cancel(f, { turno_id: id, confirmada: false }, LATE);

    expect(result.content).toMatchObject({ cancelado: false, derivada: true });
    expect(result.options).toEqual([]);
    expect(await statusOf(id)).toBe('CONFIRMED');
  });

  it('justo 24 horas antes todavía está dentro de plazo', async () => {
    const f = await setup({ settings: { depositRequirement: 'never' } });
    const id = await book(f);

    const result = await cancel(f, { turno_id: id, confirmada: true }, at('2026-10-05', '10:00'));

    expect(result.content).toMatchObject({ cancelado: true });
    expect(await handoffsOf(f)).toEqual([]);
  });

  it('un turno que ya empezó tampoco se cancela: deriva', async () => {
    const f = await setup({ settings: { depositRequirement: 'never' } });
    const id = await book(f);

    const result = await cancel(f, { turno_id: id, confirmada: true }, at('2026-10-06', '10:30'));

    expect(result.content).toMatchObject({ cancelado: false, derivada: true, motivo: 'el turno ya empezó' });
    expect(await statusOf(id)).toBe('CONFIRMED');
    expect(await handoffsOf(f)).toEqual([
      expect.objectContaining({ summary: 'Pide cancelar un turno que ya empezó: el del martes 6/10 10:00' }),
    ]);
  });

  it('usa el plazo del negocio: con 48 horas, 30 horas antes ya es tarde', async () => {
    const f = await setup({ settings: { depositRequirement: 'never', freeCancellationNoticeHours: 48 } });
    const id = await book(f);

    const result = await cancel(f, { turno_id: id, confirmada: true }, at('2026-10-05', '04:00'));

    expect(result.content).toMatchObject({
      derivada: true,
      motivo: 'faltan menos de 48 horas para el turno',
      politica: 'se cancela sin costo con al menos 48 horas de anticipación',
    });
  });

  it('pedirlo otra vez en la misma pausa no duplica la derivación', async () => {
    const f = await setup({ settings: { depositRequirement: 'never' } });
    const id = await book(f);

    await cancel(f, { turno_id: id, confirmada: false }, LATE);
    await cancel(f, { turno_id: id, confirmada: true }, LATE);

    expect(await handoffsOf(f)).toHaveLength(1);
  });

  it('fuera del horario de atención, dice cuándo responde una persona', async () => {
    const f = await setup({ settings: { depositRequirement: 'never' } });
    const id = await book(f);

    // Lunes 5/10 a las 19:00: la atención cerró; el martes a las 9:00 vuelve.
    const result = await cancel(f, { turno_id: id, confirmada: true }, at('2026-10-05', '19:00'));

    expect(result.content).toMatchObject({ derivada: true, cuando: 'el martes 6/10 a las 9:00' });
  });
});

describe('cancelar_turno: solo los turnos de esta clienta (regla 2)', () => {
  it('el turno de otra clienta del mismo negocio no se ve, no se cancela y no deriva', async () => {
    const f = await setup();
    const other = single(
      await db.insert(customers).values({ tenantId: f.tenantId, phone: '+5492614333333', name: 'Otra' }).returning({ id: customers.id }),
    ).id;
    const theirs = await book(f, TUESDAY_10, other);

    const confirm = await cancel(f, { turno_id: `turno:${theirs}`, confirmada: true });
    const ask = await cancel(f, { turno_id: `turno:${theirs}`, confirmada: false });

    for (const result of [confirm, ask]) {
      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ cancelado: false, motivo: 'turno_no_encontrado' });
      expect(result.options).toEqual([]);
    }
    expect(await statusOf(theirs)).toBe('PENDING_DEPOSIT');
    expect(await handoffsOf(f)).toEqual([]);
  });

  it('el turno de otro negocio tampoco', async () => {
    const f = await setup();
    const other = await setup();
    const theirs = await book(other);

    const result = await cancel(f, { turno_id: theirs, confirmada: true });

    expect(result.isError).toBe(true);
    expect(await statusOf(theirs)).toBe('PENDING_DEPOSIT');
  });

  it.each([
    ['un texto cualquiera', 'el del martes'],
    ['el id de la confirmación', 'cancelar:00000000-0000-4000-8000-000000000301'],
    ['un turno que no existe', 'turno:00000000-0000-4000-8000-0000000000ff'],
  ])('%s no es un turno de la clienta', async (_case, turno_id) => {
    const f = await setup();
    await book(f);

    const result = await cancel(f, { turno_id, confirmada: true });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ cancelado: false });
  });

  it('exige confirmada: sin ese dato no cancela', async () => {
    const f = await setup();
    const id = await book(f);

    const result = await cancel(f, { turno_id: id });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: 'Entrada inválida' });
    expect(await statusOf(id)).toBe('PENDING_DEPOSIT');
  });
});
