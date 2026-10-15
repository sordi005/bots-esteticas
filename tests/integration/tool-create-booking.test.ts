import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { choiceIds } from '../../src/modules/conversation/tools/choice-ids.js';
import { createBookingTool } from '../../src/modules/conversation/tools/create-booking.js';
import { runTool } from '../../src/modules/conversation/tools/tool.js';
import { customers } from '../../src/modules/customers/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { bookAppointment, changeAppointmentStatus } from '../../src/modules/scheduling/booking.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, toolContext, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';
import { expectChangeMarkOnlyOnSuccess, expectOptionsShownToModel } from './support/tool-options.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// "Ahora" por defecto: domingo 4/10/2026 a las 9:00 en Mendoza. El lunes 5/10 a las 9:00 es un horario libre de Mica.
const MONDAY_9 = at('2026-10-05', '09:00');

const slot = (f: CatalogFixture, start = MONDAY_9, serviceId = f.semi, professionalId = f.mica) =>
  choiceIds.slot(serviceId, professionalId, start);

/**
 * Por defecto la clienta eligió el horario que se pide (el caso normal: tocó el botón). `chosen`
 * cambia lo que eligió: nada, o un horario distinto del que pide el modelo.
 */
const book = async (f: CatalogFixture, input: unknown, options: { now?: Date; chosen?: string[] } = {}) => {
  const requested = (input as { horario_id?: unknown }).horario_id;
  const chosen = options.chosen ?? (typeof requested === 'string' ? [requested] : []);
  const result = await runTool(
    createBookingTool,
    input,
    toolContext(db, f, { ...(options.now ? { now: options.now } : {}), chosenOptionIds: new Set(chosen) }),
  );
  // En todos los casos de este archivo: la marca de cambio confirmado va solo con reservado=true.
  expectChangeMarkOnlyOnSuccess(result, 'reservado');
  return result;
};

const setName = (f: CatalogFixture, name: string | null) =>
  db.update(customers).set({ name }).where(eq(customers.id, f.customerId));

const nameOf = async (f: CatalogFixture) =>
  single(await db.select({ name: customers.name }).from(customers).where(eq(customers.id, f.customerId))).name;

const appointmentsOf = (f: CatalogFixture) =>
  db
    .select()
    .from(appointments)
    .where(and(eq(appointments.tenantId, f.tenantId), eq(appointments.customerId, f.customerId)));

describe('crear_reserva: el camino feliz', () => {
  it('reserva con seña: queda pendiente de seña, con el monto, el plazo y el medio escritos por el código', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    expect(result.isError).toBeFalsy();
    expect(result.options).toEqual([]);
    const [appointment] = await appointmentsOf(f);
    expect(appointment).toMatchObject({ status: 'PENDING_DEPOSIT', origin: 'assistant', serviceId: f.semi, professionalId: f.mica });
    expect(result.content).toEqual({
      reservado: true,
      turnoId: `turno:${appointment?.id ?? ''}`,
      servicio: 'Esmaltado semipermanente',
      profesional: 'Mica',
      fecha: 'lunes 5/10 9:00',
      estado: 'pendiente de seña',
      sena: { monto: '$5.400', estado: 'pendiente de pago', pagarHasta: 'hoy a las 10:00', medio: 'transferencia' },
      mensaje: 'Quedó reservado, pendiente de seña: si no se paga hoy a las 10:00, se libera el horario.',
    });
  });

  it('guarda la seña y el evento de creación del asistente, en la base', async () => {
    const f = await createCatalogFixture(db);

    await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    const appointment = single(await appointmentsOf(f));
    const [deposit] = await db.select().from(deposits).where(eq(deposits.appointmentId, appointment.id));
    expect(deposit).toMatchObject({ amountCents: 540_000, status: 'pending' });
    const events = await db.select().from(appointmentEvents).where(eq(appointmentEvents.appointmentId, appointment.id));
    expect(events).toEqual([expect.objectContaining({ actor: 'assistant', fromStatus: null, toStatus: 'PENDING_DEPOSIT' })]);
  });

  it('un servicio sin seña queda confirmado, sin datos de seña', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    expect(result.content).toMatchObject({ reservado: true, estado: 'confirmado' });
    expect(result.content).not.toHaveProperty('sena');
  });

  it('si el plazo de la seña vence otro día, lo dice con el día', async () => {
    const f = await createCatalogFixture(db, { settings: { depositPaymentWindowMinutes: 24 * 60 } });

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    expect(result.content).toMatchObject({ sena: { pagarHasta: 'el lunes 5/10 a las 9:00' } });
  });

  it('dice el medio que eligió el negocio', async () => {
    const f = await createCatalogFixture(db, { settings: { depositPaymentOptions: 'mercadopago' } });

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    expect(result.content).toMatchObject({ sena: { medio: 'Mercado Pago' } });
  });

  it('el id del horario puede ser el de otra profesional que hace el servicio', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(f, at('2026-10-06', '10:00'), f.semi, f.sofi), nombre: 'Caro Pérez' });

    expect(result.content).toMatchObject({ reservado: true, profesional: 'Sofi', fecha: 'martes 6/10 10:00' });
  });
});

describe('crear_reserva: solo sobre un horario que eligió la clienta (6.4)', () => {
  it('si la clienta no eligió ese horario no reserva: lo devuelve como opción para que lo confirme', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' }, { chosen: [] });

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({
      reservado: false,
      motivo: 'falta_que_elija',
      horario: { opcionId: slot(f), texto: 'lunes 5/10 9:00', profesional: 'Mica', inicio: '2026-10-05T12:00:00.000Z' },
    });
    expect(JSON.stringify(result.content)).toMatch(/todavía no eligió este horario.*ofrecéselo como opción/);
    expect(result.options).toEqual([{ id: slot(f), title: 'lun 5/10 9:00', description: 'con Mica' }]);
    expectOptionsShownToModel(result);
    expect(await appointmentsOf(f)).toEqual([]);
  });

  it('tampoco guarda el nombre: no se hizo nada', async () => {
    const f = await createCatalogFixture(db);

    await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' }, { chosen: [] });

    expect(await nameOf(f)).toBeNull();
  });

  it('el horario que eligió es otro: el que pide el modelo no cuenta', async () => {
    const f = await createCatalogFixture(db);
    const tuesday = slot(f, at('2026-10-06', '09:00'));

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' }, { chosen: [tuesday] });

    expect(result.content).toMatchObject({ reservado: false, motivo: 'falta_que_elija', horario: { opcionId: slot(f), texto: 'lunes 5/10 9:00' } });
    expect(await appointmentsOf(f)).toEqual([]);
  });

  it('con la elección de la clienta (esta vuelta o el historial) reserva ese mismo horario', async () => {
    const f = await createCatalogFixture(db);
    const other = slot(f, at('2026-10-06', '09:00'));

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' }, { chosen: [other, slot(f)] });

    expect(result.content).toMatchObject({ reservado: true });
    expect(await appointmentsOf(f)).toHaveLength(1);
  });

  it('la elección va antes que el nombre: sin ninguno de los dos, primero se confirma el horario', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(f) }, { chosen: [] });

    expect(result.content).toMatchObject({ reservado: false, motivo: 'falta_que_elija' });
  });

  it('un reintento sigue siendo idempotente aunque ya no figure la elección: devuelve el turno que ya existe', async () => {
    const f = await createCatalogFixture(db);
    const first = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    const retry = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' }, { chosen: [], now: at('2026-10-04', '09:05') });

    expect(retry.content).toMatchObject({
      reservado: true,
      yaEstabaReservado: true,
      turnoId: (first.content as { turnoId: string }).turnoId,
    });
  });

  it('un horario que otra clienta ya ocupó se rechaza sin ofrecerlo como botón', async () => {
    const f = await createCatalogFixture(db);
    const [other] = await db
      .insert(customers)
      .values({ tenantId: f.tenantId, phone: '+5492614555555', name: 'Otra' })
      .returning({ id: customers.id });
    await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: other?.id ?? '',
      serviceId: f.semi,
      professionalId: f.mica,
      start: MONDAY_9,
      actor: 'assistant',
      now: at('2026-10-04', '09:00'),
    });

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' }, { chosen: [] });

    expect(result.content).toMatchObject({ reservado: false, motivo: 'horario_no_disponible' });
    expect(JSON.stringify(result.content)).toMatch(/consultar_disponibilidad/);
    expect(result.options).toEqual([]);
  });

  it('un servicio de otro negocio es un error aunque no haya elección: no se ofrece nada', async () => {
    const f = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(other), nombre: 'Caro Pérez' }, { chosen: [] });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reservado: false, motivo: 'no_encontrado' });
    expect(result.options).toEqual([]);
  });

  it('un id que no es de un horario se rechaza como inválido, haya elegido o no', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: 'el de las 15', nombre: 'Caro Pérez' }, { chosen: [] });

    expect(result.content).toMatchObject({ motivo: 'id_de_horario_invalido' });
  });
});

describe('crear_reserva: el nombre para el turno (4.9)', () => {
  it('sin nombre en la ficha y sin nombre en la llamada, no reserva y le dice al modelo que lo pida', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(f) });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reservado: false, motivo: 'falta_nombre' });
    expect(JSON.stringify(result.content)).toMatch(/pedile el nombre/i);
    expect(await appointmentsOf(f)).toEqual([]);
  });

  it('con el nombre, lo guarda en la ficha', async () => {
    const f = await createCatalogFixture(db);

    await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    expect(await nameOf(f)).toBe('Caro Pérez');
  });

  it('recorta los espacios del nombre', async () => {
    const f = await createCatalogFixture(db);

    await book(f, { horario_id: slot(f), nombre: '   Caro Pérez  ' });

    expect(await nameOf(f)).toBe('Caro Pérez');
  });

  it('si la clienta ya tiene nombre, reserva sin pedirlo y lo conserva', async () => {
    const f = await createCatalogFixture(db);
    await setName(f, 'Caro Pérez');

    const result = await book(f, { horario_id: slot(f) });

    expect(result.content).toMatchObject({ reservado: true });
    expect(await nameOf(f)).toBe('Caro Pérez');
  });

  it('si viene un nombre, reemplaza al de la ficha', async () => {
    const f = await createCatalogFixture(db);
    await setName(f, 'Caro');

    await book(f, { horario_id: slot(f), nombre: 'Carolina Pérez' });

    expect(await nameOf(f)).toBe('Carolina Pérez');
  });

  it.each([
    ['uno de un caracter', 'A'],
    ['solo espacios', '    '],
    ['de más de 80 caracteres', 'x'.repeat(81)],
  ])('un nombre %s no es válido: no reserva ni guarda nada', async (_case, nombre) => {
    const f = await createCatalogFixture(db);
    await setName(f, 'Caro');

    const result = await book(f, { horario_id: slot(f), nombre });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: 'Entrada inválida' });
    expect(await appointmentsOf(f)).toEqual([]);
    expect(await nameOf(f)).toBe('Caro');
  });
});

describe('crear_reserva: es idempotente', () => {
  it('pedirlo dos veces devuelve el mismo turno como reservado, sin responder que el horario se ocupó', async () => {
    const f = await createCatalogFixture(db);
    const first = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    const second = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' }, { now: at('2026-10-04', '09:05') });

    expect(second.isError).toBeFalsy();
    expect(second.content).toMatchObject({
      reservado: true,
      yaEstabaReservado: true,
      turnoId: (first.content as { turnoId: string }).turnoId,
      estado: 'pendiente de seña',
      sena: { monto: '$5.400', pagarHasta: 'hoy a las 10:00' },
    });
    expect(await appointmentsOf(f)).toHaveLength(1);
  });

  it('dos llamadas a la vez dejan un solo turno y las dos dicen reservado', async () => {
    const f = await createCatalogFixture(db);
    await setName(f, 'Caro Pérez');

    const [a, b] = await Promise.all([book(f, { horario_id: slot(f) }), book(f, { horario_id: slot(f) })]);

    expect(a.content).toMatchObject({ reservado: true });
    expect(b.content).toMatchObject({ reservado: true });
    expect(await appointmentsOf(f)).toHaveLength(1);
  });

  it('un reintento también guarda el nombre si todavía no estaba', async () => {
    const f = await createCatalogFixture(db);
    await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });
    await setName(f, null);

    await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' }, { now: at('2026-10-04', '09:05') });

    expect(await nameOf(f)).toBe('Caro Pérez');
  });

  it('el turno de otra clienta en ese horario NO cuenta como reservado: se ocupó', async () => {
    const f = await createCatalogFixture(db);
    const [other] = await db
      .insert(customers)
      .values({ tenantId: f.tenantId, phone: '+5492614777777', name: 'Otra' })
      .returning({ id: customers.id });
    await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: other?.id ?? '',
      serviceId: f.semi,
      professionalId: f.mica,
      start: MONDAY_9,
      actor: 'assistant',
      now: at('2026-10-04', '09:00'),
    });

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    expect(result.content).toMatchObject({ reservado: false, motivo: 'horario_ocupado' });
    expect(await appointmentsOf(f)).toEqual([]);
  });

  it('un turno que la clienta canceló no cuenta: reservar de nuevo crea otro', async () => {
    const f = await createCatalogFixture(db);
    const first = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });
    const firstId = (first.content as { turnoId: string }).turnoId.replace('turno:', '');
    await changeAppointmentStatus(db, {
      tenantId: f.tenantId,
      appointmentId: firstId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: at('2026-10-04', '09:02'),
    });

    const again = await book(f, { horario_id: slot(f) }, { now: at('2026-10-04', '09:05') });

    expect(again.content).toMatchObject({ reservado: true });
    expect(again.content).not.toHaveProperty('yaEstabaReservado');
    expect(await appointmentsOf(f)).toHaveLength(2);
  });
});

describe('crear_reserva: rechazos traducidos para el modelo', () => {
  it('el horario se acaba de ocupar: que vuelva a consultar la disponibilidad', async () => {
    const f = await createCatalogFixture(db);
    const [other] = await db
      .insert(customers)
      .values({ tenantId: f.tenantId, phone: '+5492614666666', name: 'Otra' })
      .returning({ id: customers.id });
    await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: other?.id ?? '',
      serviceId: f.semi,
      professionalId: f.mica,
      start: MONDAY_9,
      actor: 'assistant',
      now: at('2026-10-04', '09:00'),
    });

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({ reservado: false, motivo: 'horario_ocupado' });
    expect(JSON.stringify(result.content)).toMatch(/se acaba de ocupar.*consultar_disponibilidad/);
  });

  it('un horario que no es válido (domingo, fuera del horario de la profesional)', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(f, at('2026-10-11', '10:00')), nombre: 'Caro Pérez' });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reservado: false, motivo: 'horario_no_valido' });
    expect(await appointmentsOf(f)).toEqual([]);
  });

  it('un servicio que requiere consulta previa no se reserva: que derive con consulta_previa', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(f, at('2026-10-06', '11:00'), f.laser, f.sofi), nombre: 'Caro Pérez' });

    expect(result.content).toMatchObject({ reservado: false, motivo: 'servicio_no_reservable' });
    expect(JSON.stringify(result.content)).toMatch(/consulta_previa en el campo «derivar»/);
    expect(JSON.stringify(result.content)).not.toContain('derivar_a_persona');
    expect(await appointmentsOf(f)).toEqual([]);
  });

  it('un servicio que el negocio no ofrece tampoco', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(f, MONDAY_9, f.hidden), nombre: 'Caro Pérez' });

    expect(result.content).toMatchObject({ reservado: false, motivo: 'servicio_no_reservable' });
  });

  it('una profesional que no hace el servicio es un error', async () => {
    const f = await createCatalogFixture(db);

    // Sofi no hace uñas esculpidas.
    const result = await book(f, { horario_id: slot(f, at('2026-10-06', '11:00'), f.sculpted, f.sofi), nombre: 'Caro Pérez' });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reservado: false, motivo: 'profesional_no_hace_el_servicio' });
  });

  it('un servicio de otro negocio es un error: no se reserva nada', async () => {
    const f = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(other), nombre: 'Caro Pérez' });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reservado: false, motivo: 'no_encontrado' });
    expect(await appointmentsOf(f)).toEqual([]);
    expect(await appointmentsOf(other)).toEqual([]);
  });

  it.each([
    ['un texto cualquiera', 'el de las 15'],
    ['el id de un servicio', 'servicio:00000000-0000-4000-8000-000000000201'],
    ['el id de un turno', 'turno:00000000-0000-4000-8000-000000000301'],
    ['un horario armado a mano', 'horario:semi:mica:mañana'],
  ])('%s no es un id de horario: no reserva', async (_case, horario_id) => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id, nombre: 'Caro Pérez' });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ reservado: false, motivo: 'id_de_horario_invalido' });
    expect(await appointmentsOf(f)).toEqual([]);
  });

  describe('un id reprogramar: es para mover un turno, no para reservar (decisión 28)', () => {
    const rescheduleId = (appointmentId = '00000000-0000-4000-8000-000000000301', start = MONDAY_9) =>
      choiceIds.reschedule(appointmentId, start);

    it('no reserva nada y le dice al modelo que use reprogramar_turno', async () => {
      const f = await createCatalogFixture(db);

      const result = await book(f, { horario_id: rescheduleId(), nombre: 'Caro Pérez' });

      expect(result.isError).toBe(true);
      expect(result.options).toEqual([]);
      expect(result.content).toMatchObject({ reservado: false, motivo: 'horario_para_reprogramar' });
      expect(JSON.stringify(result.content)).toMatch(/ese horario es para reprogramar su turno: usá reprogramar_turno/i);
      expect(await appointmentsOf(f)).toEqual([]);
    });

    it('tampoco si la clienta lo eligió con el botón: es la falla que vieron las evaluaciones, con dos turnos', async () => {
      const f = await createCatalogFixture(db);
      const existing = await bookAppointment(db, {
        tenantId: f.tenantId,
        customerId: f.customerId,
        serviceId: f.semi,
        professionalId: f.mica,
        start: at('2026-10-06', '10:00'),
        actor: 'assistant',
        now: at('2026-10-04', '09:00'),
      });
      if (!existing.ok) throw new Error(existing.reason);
      const chosen = rescheduleId(existing.appointmentId, at('2026-10-07', '10:00'));
      await setName(f, 'Caro Pérez');

      const result = await book(f, { horario_id: chosen }, { chosen: [chosen] });

      expect(result.content).toMatchObject({ reservado: false, motivo: 'horario_para_reprogramar' });
      expect((await appointmentsOf(f)).map((appointment) => appointment.id)).toEqual([existing.appointmentId]);
    });
  });

  it('el negocio y la clienta salen del contexto: lo que mande el modelo no cambia nada', async () => {
    const f = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);

    await book(f, { horario_id: slot(f), nombre: 'Caro Pérez', cliente_id: other.customerId, tenant_id: other.tenantId });

    expect(await appointmentsOf(f)).toHaveLength(1);
    expect(await appointmentsOf(other)).toEqual([]);
  });
});

describe('crear_reserva: la marca de cambio confirmado (6.4)', () => {
  it('una reserva nueva lleva la marca', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    expect(result.content).toMatchObject({ reservado: true });
    expect(result.changedAppointment).toBe(true);
  });

  it('un reintento que devuelve el turno que ya estaba también la lleva: la clienta tiene ese turno', async () => {
    const f = await createCatalogFixture(db);
    await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    const retry = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' }, { chosen: [] });

    expect(retry.content).toMatchObject({ reservado: true, yaEstabaReservado: true });
    expect(retry.changedAppointment).toBe(true);
  });

  it('cuando falta que la clienta elija el horario no la lleva: no se reservó nada', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' }, { chosen: [] });

    expect(result.content).toMatchObject({ reservado: false, motivo: 'falta_que_elija' });
    expect(result.changedAppointment).toBeUndefined();
  });

  it('un rechazo (falta el nombre, el id no es de un horario) no la lleva', async () => {
    const f = await createCatalogFixture(db);

    const withoutName = await book(f, { horario_id: slot(f) });
    const invalidId = await book(f, { horario_id: 'cualquier cosa', nombre: 'Caro Pérez' });

    expect(withoutName.content).toMatchObject({ reservado: false, motivo: 'falta_nombre' });
    expect(invalidId.content).toMatchObject({ reservado: false, motivo: 'id_de_horario_invalido' });
    expect(withoutName.changedAppointment).toBeUndefined();
    expect(invalidId.changedAppointment).toBeUndefined();
  });

  it('un horario que otra clienta ocupó no la lleva', async () => {
    const f = await createCatalogFixture(db);
    const [other] = await db
      .insert(customers)
      .values({ tenantId: f.tenantId, phone: '+5492614666667', name: 'Otra' })
      .returning({ id: customers.id });
    await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: other?.id ?? '',
      serviceId: f.semi,
      professionalId: f.mica,
      start: MONDAY_9,
      actor: 'assistant',
      now: at('2026-10-04', '09:00'),
    });

    const result = await book(f, { horario_id: slot(f), nombre: 'Caro Pérez' });

    expect(result.content).toMatchObject({ reservado: false, motivo: 'horario_ocupado' });
    expect(result.changedAppointment).toBeUndefined();
  });

  it('la entrada inválida (sin horario_id) tampoco', async () => {
    const f = await createCatalogFixture(db);

    const result = await book(f, {});

    expect(result.isError).toBe(true);
    expect(result.changedAppointment).toBeUndefined();
  });
});
