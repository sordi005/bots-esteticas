import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { professionals, services } from '../../src/modules/catalog/schema.js';
import { choiceIds } from '../../src/modules/conversation/tools/choice-ids.js';
import { resolveChoice } from '../../src/modules/conversation/tools/choices.js';
import { customers } from '../../src/modules/customers/schema.js';
import { bookAppointment, changeAppointmentStatus } from '../../src/modules/scheduling/booking.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, toolContext, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Octubre de 2026 en Mendoza: el 4 es domingo y el 5 lunes.
const MONDAY_9 = at('2026-10-05', '09:00');

function resolve(
  fixture: CatalogFixture,
  replyId: string,
  overrides: Parameters<typeof toolContext>[2] = {},
) {
  return resolveChoice(db, toolContext(db, fixture, overrides), replyId);
}

const slotId = (fixture: CatalogFixture, start: Date, professionalId = fixture.mica, serviceId = fixture.semi) =>
  choiceIds.slot(serviceId, professionalId, start);

describe('resolveChoice: un servicio elegido', () => {
  it('resuelve un servicio del negocio con su precio y duración escritos', async () => {
    const fixture = await createCatalogFixture(db);

    const choice = await resolve(fixture, choiceIds.service(fixture.semi));

    expect(choice).toEqual({
      tipo: 'servicio',
      servicioId: fixture.semi,
      nombre: 'Esmaltado semipermanente',
      precioTexto: '$18.000 ($16.000 en efectivo o transferencia)',
      duracionTexto: '60 min (con Sofi, 75 min)',
      requiereConsultaPrevia: false,
    });
  });

  it('un servicio que requiere consulta previa se resuelve y lo marca', async () => {
    const fixture = await createCatalogFixture(db);

    const choice = await resolve(fixture, choiceIds.service(fixture.laser));

    expect(choice).toMatchObject({ tipo: 'servicio', requiereConsultaPrevia: true });
  });

  it('un servicio de otro negocio, que no se ofrece o que no existe es desconocido', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);

    expect(await resolve(mine, choiceIds.service(other.semi))).toEqual({ tipo: 'desconocido' });
    expect(await resolve(mine, choiceIds.service(mine.hidden))).toEqual({ tipo: 'desconocido' });
    expect(await resolve(mine, choiceIds.service('00000000-0000-4000-8000-0000000000ff'))).toEqual({
      tipo: 'desconocido',
    });
  });
});

describe('resolveChoice: un horario elegido se vuelve a validar contra la base (5.3)', () => {
  it('un horario que sigue libre se resuelve con sus textos', async () => {
    const fixture = await createCatalogFixture(db);

    const choice = await resolve(fixture, slotId(fixture, MONDAY_9));

    expect(choice).toEqual({
      tipo: 'horario',
      servicioId: fixture.semi,
      servicioNombre: 'Esmaltado semipermanente',
      profesionalId: fixture.mica,
      profesionalNombre: 'Mica',
      inicio: '2026-10-05T12:00:00.000Z',
      texto: 'lunes 5/10 9:00',
      duracionMinutos: 60,
      sigueLibre: true,
    });
  });

  it('la duración es la de la profesional elegida', async () => {
    const fixture = await createCatalogFixture(db);

    const choice = await resolve(fixture, slotId(fixture, at('2026-10-06', '10:00'), fixture.sofi));

    expect(choice).toMatchObject({ tipo: 'horario', profesionalNombre: 'Sofi', duracionMinutos: 75, sigueLibre: true });
  });

  it('si otra clienta tomó el horario después de ofrecerlo, ya no sigue libre', async () => {
    const fixture = await createCatalogFixture(db);
    const id = slotId(fixture, MONDAY_9);
    expect(await resolve(fixture, id)).toMatchObject({ tipo: 'horario', sigueLibre: true });

    const booked = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: fixture.customerId,
      serviceId: fixture.semi,
      professionalId: fixture.mica,
      start: MONDAY_9,
      actor: 'assistant',
      now: at('2026-10-04', '09:00'),
    });
    expect(booked.ok).toBe(true);

    const choice = await resolve(fixture, id);

    expect(choice).toMatchObject({ tipo: 'horario', texto: 'lunes 5/10 9:00', sigueLibre: false });
  });

  it('un horario que se pisa con un turno de la profesional tampoco está libre', async () => {
    const fixture = await createCatalogFixture(db);
    await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: fixture.customerId,
      serviceId: fixture.semi,
      professionalId: fixture.mica,
      start: MONDAY_9,
      actor: 'assistant',
      now: at('2026-10-04', '09:00'),
    });

    // 9:45 pisa el turno de 9:00 a 10:10.
    const choice = await resolve(fixture, slotId(fixture, at('2026-10-05', '09:45')));

    expect(choice).toMatchObject({ tipo: 'horario', sigueLibre: false });
  });

  it('un horario que ya pasó o que no cumple la anticipación mínima no está libre', async () => {
    const fixture = await createCatalogFixture(db);

    const choice = await resolve(fixture, slotId(fixture, MONDAY_9), { now: at('2026-10-05', '08:30') });

    expect(choice).toMatchObject({ tipo: 'horario', sigueLibre: false });
  });

  it('un horario fuera del horario de trabajo no está libre', async () => {
    const fixture = await createCatalogFixture(db);

    // El domingo no se trabaja.
    const choice = await resolve(fixture, slotId(fixture, at('2026-10-11', '10:00')));

    expect(choice).toMatchObject({ tipo: 'horario', sigueLibre: false });
  });

  it('si el servicio pasó a requerir consulta previa, el horario ya no sirve', async () => {
    const fixture = await createCatalogFixture(db);
    const id = slotId(fixture, MONDAY_9);
    await db.update(services).set({ requiresConsultation: true }).where(eq(services.id, fixture.semi));

    expect(await resolve(fixture, id)).toMatchObject({ tipo: 'horario', sigueLibre: false });
  });

  it('si la dueña dejó de ofrecer el servicio, el horario ya no sirve', async () => {
    const fixture = await createCatalogFixture(db);
    const id = slotId(fixture, MONDAY_9);
    await db.update(services).set({ visible: false }).where(eq(services.id, fixture.semi));

    expect(await resolve(fixture, id)).toMatchObject({ tipo: 'horario', sigueLibre: false });
  });

  it('si la profesional se dio de baja, el horario ya no sirve', async () => {
    const fixture = await createCatalogFixture(db);
    const id = slotId(fixture, MONDAY_9);
    await db.update(professionals).set({ active: false }).where(eq(professionals.id, fixture.mica));

    expect(await resolve(fixture, id)).toMatchObject({ tipo: 'horario', profesionalNombre: 'Mica', sigueLibre: false });
  });

  it('un id de otro negocio es desconocido: el servicio o la profesional no son de este', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);

    expect(await resolve(mine, slotId(other, MONDAY_9))).toEqual({ tipo: 'desconocido' });
    // Servicio propio con la profesional de otro negocio.
    expect(await resolve(mine, slotId(mine, MONDAY_9, other.mica))).toEqual({ tipo: 'desconocido' });
    // Servicio de otro negocio con una profesional propia.
    expect(await resolve(mine, slotId(mine, MONDAY_9, mine.mica, other.semi))).toEqual({ tipo: 'desconocido' });
  });

  it('un servicio o una profesional que no existen son desconocidos', async () => {
    const fixture = await createCatalogFixture(db);
    const missing = '00000000-0000-4000-8000-0000000000ff';

    expect(await resolve(fixture, slotId(fixture, MONDAY_9, fixture.mica, missing))).toEqual({
      tipo: 'desconocido',
    });
    expect(await resolve(fixture, slotId(fixture, MONDAY_9, missing))).toEqual({ tipo: 'desconocido' });
  });
});

describe('resolveChoice: "ver otros horarios"', () => {
  it('devuelve el servicio, la profesional si había y desde qué horario seguir', async () => {
    const fixture = await createCatalogFixture(db);
    const after = at('2026-10-05', '12:00');

    expect(await resolve(fixture, choiceIds.more(fixture.semi, null, after))).toEqual({
      tipo: 'ver_mas',
      servicioId: fixture.semi,
      profesionalId: null,
      despuesDe: '2026-10-05T15:00:00.000Z',
    });
    expect(await resolve(fixture, choiceIds.more(fixture.semi, fixture.mica, after))).toEqual({
      tipo: 'ver_mas',
      servicioId: fixture.semi,
      profesionalId: fixture.mica,
      despuesDe: '2026-10-05T15:00:00.000Z',
    });
  });

  it('un servicio o una profesional de otro negocio es desconocido', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    const after = at('2026-10-05', '12:00');

    expect(await resolve(mine, choiceIds.more(other.semi, null, after))).toEqual({ tipo: 'desconocido' });
    expect(await resolve(mine, choiceIds.more(mine.semi, other.mica, after))).toEqual({ tipo: 'desconocido' });
  });
});

describe('resolveChoice: un turno elegido o la confirmación de cancelarlo (4.6)', () => {
  async function bookFor(fixture: CatalogFixture, customerId = fixture.customerId, start = MONDAY_9) {
    const booked = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId,
      serviceId: fixture.semi,
      professionalId: fixture.mica,
      start,
      actor: 'assistant',
      now: at('2026-10-04', '09:00'),
    });
    if (!booked.ok) throw new Error(booked.reason);
    return booked.appointmentId;
  }

  const otherCustomer = async (fixture: CatalogFixture) =>
    single(
      await db
        .insert(customers)
        .values({ tenantId: fixture.tenantId, phone: '+5492614888888', name: 'Otra' })
        .returning({ id: customers.id }),
    ).id;

  it('un turno de la clienta se resuelve con su servicio, profesional, fecha y estado escritos', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookFor(fixture);

    const choice = await resolve(fixture, choiceIds.appointment(appointmentId));

    expect(choice).toEqual({
      tipo: 'turno',
      turnoId: appointmentId,
      servicioId: fixture.semi,
      profesionalId: fixture.mica,
      servicioNombre: 'Esmaltado semipermanente',
      profesionalNombre: 'Mica',
      texto: 'lunes 5/10 9:00',
      estado: 'pendiente de seña',
      ocupaHorario: true,
    });
  });

  it('el botón "Sí, cancelar" se resuelve con el mismo turno', async () => {
    const fixture = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    const appointmentId = await bookFor(fixture);

    const choice = await resolve(fixture, choiceIds.cancel(appointmentId));

    expect(choice).toEqual({
      tipo: 'cancelar',
      turnoId: appointmentId,
      servicioId: fixture.semi,
      profesionalId: fixture.mica,
      servicioNombre: 'Esmaltado semipermanente',
      profesionalNombre: 'Mica',
      texto: 'lunes 5/10 9:00',
      estado: 'confirmado',
      ocupaHorario: true,
    });
  });

  it('un turno que ya no ocupa horario se resuelve igual, y lo dice', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookFor(fixture);
    await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: at('2026-10-04', '09:05'),
    });

    expect(await resolve(fixture, choiceIds.cancel(appointmentId))).toMatchObject({
      tipo: 'cancelar',
      estado: 'cancelado',
      ocupaHorario: false,
    });
  });

  it('el turno de otra clienta del mismo negocio es desconocido, con los dos tipos de id', async () => {
    const fixture = await createCatalogFixture(db);
    const theirs = await bookFor(fixture, await otherCustomer(fixture));

    expect(await resolve(fixture, choiceIds.appointment(theirs))).toEqual({ tipo: 'desconocido' });
    expect(await resolve(fixture, choiceIds.cancel(theirs))).toEqual({ tipo: 'desconocido' });
  });

  it('el turno de otro negocio o que no existe es desconocido', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    const theirs = await bookFor(other, other.customerId);

    expect(await resolve(mine, choiceIds.appointment(theirs))).toEqual({ tipo: 'desconocido' });
    expect(await resolve(mine, choiceIds.cancel(theirs))).toEqual({ tipo: 'desconocido' });
    expect(await resolve(mine, choiceIds.cancel('00000000-0000-4000-8000-0000000000ff'))).toEqual({
      tipo: 'desconocido',
    });
  });

  it.each([
    ['confirm', 'confirmar'],
    ['reschedule', 'reprogramar'],
    ['cancel', 'cancelar'],
  ] as const)('un botón del recordatorio (%s) se resuelve con su turno y la intención (4.7)', async (action, accion) => {
    const fixture = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    const appointmentId = await bookFor(fixture);

    expect(await resolve(fixture, choiceIds.reminder(appointmentId, action))).toEqual({
      tipo: 'recordatorio',
      accion,
      turnoId: appointmentId,
      servicioId: fixture.semi,
      profesionalId: fixture.mica,
      servicioNombre: 'Esmaltado semipermanente',
      profesionalNombre: 'Mica',
      texto: 'lunes 5/10 9:00',
      estado: 'confirmado',
      ocupaHorario: true,
    });
  });

  it('el recordatorio de otra clienta o de otro negocio es desconocido', async () => {
    const fixture = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    const theirs = await bookFor(fixture, await otherCustomer(fixture));
    const otherTenant = await bookFor(other, other.customerId);

    expect(await resolve(fixture, choiceIds.reminder(theirs, 'confirm'))).toEqual({ tipo: 'desconocido' });
    expect(await resolve(fixture, choiceIds.reminder(otherTenant, 'cancel'))).toEqual({ tipo: 'desconocido' });
  });
});

describe('resolveChoice: un horario para reprogramar un turno (4.6, decisión 28)', () => {
  const TUESDAY_10 = at('2026-10-06', '10:00');

  async function bookFor(fixture: CatalogFixture, input: { customerId?: string; start?: Date; professionalId?: string } = {}) {
    const booked = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: input.customerId ?? fixture.customerId,
      serviceId: fixture.semi,
      professionalId: input.professionalId ?? fixture.mica,
      start: input.start ?? MONDAY_9,
      actor: 'assistant',
      now: at('2026-10-04', '09:00'),
    });
    if (!booked.ok) throw new Error(booked.reason);
    return booked.appointmentId;
  }

  const otherCustomer = async (fixture: CatalogFixture) =>
    single(
      await db
        .insert(customers)
        .values({ tenantId: fixture.tenantId, phone: '+5492614777777', name: 'Otra' })
        .returning({ id: customers.id }),
    ).id;

  it('resuelve el turno, el horario nuevo escrito y que sigue libre', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookFor(fixture);

    const choice = await resolve(fixture, choiceIds.reschedule(appointmentId, TUESDAY_10));

    expect(choice).toEqual({
      tipo: 'reprogramar',
      turnoId: appointmentId,
      servicioId: fixture.semi,
      profesionalId: fixture.mica,
      servicioNombre: 'Esmaltado semipermanente',
      profesionalNombre: 'Mica',
      turnoTexto: 'lunes 5/10 9:00',
      estado: 'pendiente de seña',
      ocupaHorario: true,
      inicio: TUESDAY_10.toISOString(),
      texto: 'martes 6/10 10:00',
      duracionMinutos: 60,
      sigueLibre: true,
    });
  });

  it('el horario nuevo puede pisar el lugar del propio turno: correrlo 30 minutos sigue libre', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookFor(fixture);

    const choice = await resolve(fixture, choiceIds.reschedule(appointmentId, at('2026-10-05', '09:30')));

    expect(choice).toMatchObject({ tipo: 'reprogramar', sigueLibre: true });
  });

  it('si otra clienta tomó el horario nuevo, ya no sigue libre', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookFor(fixture);
    await bookFor(fixture, { customerId: await otherCustomer(fixture), start: TUESDAY_10 });

    const choice = await resolve(fixture, choiceIds.reschedule(appointmentId, TUESDAY_10));

    expect(choice).toMatchObject({ tipo: 'reprogramar', sigueLibre: false });
  });

  it('un horario fuera del horario de trabajo no está libre', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookFor(fixture);

    const choice = await resolve(fixture, choiceIds.reschedule(appointmentId, at('2026-10-06', '03:00')));

    expect(choice).toMatchObject({ tipo: 'reprogramar', sigueLibre: false });
  });

  it('usa la duración que tiene el turno, no la actual del servicio', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookFor(fixture);
    await db.update(services).set({ durationMinutes: 30 }).where(eq(services.id, fixture.semi));

    const choice = await resolve(fixture, choiceIds.reschedule(appointmentId, TUESDAY_10));

    expect(choice).toMatchObject({ tipo: 'reprogramar', duracionMinutos: 60, sigueLibre: true });
  });

  it('un turno que ya no ocupa horario se resuelve igual, lo dice y el horario no sirve', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookFor(fixture);
    await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: at('2026-10-04', '09:05'),
    });

    expect(await resolve(fixture, choiceIds.reschedule(appointmentId, TUESDAY_10))).toMatchObject({
      tipo: 'reprogramar',
      estado: 'cancelado',
      ocupaHorario: false,
      sigueLibre: false,
    });
  });

  it('el turno de otra clienta del mismo negocio, el de otro negocio o uno que no existe son desconocidos', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    const theirs = await bookFor(mine, { customerId: await otherCustomer(mine) });
    const foreign = await bookFor(other);

    expect(await resolve(mine, choiceIds.reschedule(theirs, TUESDAY_10))).toEqual({ tipo: 'desconocido' });
    expect(await resolve(mine, choiceIds.reschedule(foreign, TUESDAY_10))).toEqual({ tipo: 'desconocido' });
    expect(
      await resolve(mine, choiceIds.reschedule('00000000-0000-4000-8000-0000000000ff', TUESDAY_10)),
    ).toEqual({ tipo: 'desconocido' });
  });
});

describe('resolveChoice: "ver otros horarios" de una reprogramación', () => {
  it('devuelve el turno y desde qué horario seguir', async () => {
    const fixture = await createCatalogFixture(db);
    const booked = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: fixture.customerId,
      serviceId: fixture.semi,
      professionalId: fixture.mica,
      start: MONDAY_9,
      actor: 'assistant',
      now: at('2026-10-04', '09:00'),
    });
    if (!booked.ok) throw new Error(booked.reason);
    const after = at('2026-10-06', '12:00');

    const choice = await resolve(fixture, choiceIds.moreReschedule(booked.appointmentId, after));

    expect(choice).toEqual({
      tipo: 'ver_mas_reprogramar',
      turnoId: booked.appointmentId,
      turnoTexto: 'lunes 5/10 9:00',
      ocupaHorario: true,
      despuesDe: after.toISOString(),
    });
  });

  it('el turno de otra clienta o de otro negocio es desconocido', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    const booked = await bookAppointment(db, {
      tenantId: other.tenantId,
      customerId: other.customerId,
      serviceId: other.semi,
      professionalId: other.mica,
      start: MONDAY_9,
      actor: 'assistant',
      now: at('2026-10-04', '09:00'),
    });
    if (!booked.ok) throw new Error(booked.reason);

    expect(await resolve(mine, choiceIds.moreReschedule(booked.appointmentId, MONDAY_9))).toEqual({
      tipo: 'desconocido',
    });
  });
});

describe('resolveChoice: nunca confía en el id', () => {
  it.each([
    ['vacío', ''],
    ['un texto cualquiera', 'quiero el de las 15'],
    ['un prefijo que no existe', 'cita:00000000-0000-4000-8000-000000000201'],
    ['un horario mal formado', 'horario:semi:mica:mañana'],
  ])('un id %s es desconocido', async (_description, replyId) => {
    const fixture = await createCatalogFixture(db);

    expect(await resolve(fixture, replyId)).toEqual({ tipo: 'desconocido' });
  });
});
