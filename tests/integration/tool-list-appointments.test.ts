import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { listAppointmentsTool } from '../../src/modules/conversation/tools/list-appointments.js';
import { runTool } from '../../src/modules/conversation/tools/tool.js';
import { customers } from '../../src/modules/customers/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { bookAppointment, changeAppointmentStatus } from '../../src/modules/scheduling/booking.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, toolContext, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { expectOptionsShownToModel } from './support/tool-options.js';
import { single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Los turnos se reservan el domingo 4/10/2026 a las 9:00 en Mendoza.
const BOOKED_AT = at('2026-10-04', '09:00');

async function book(f: CatalogFixture, date: string, time: string, customerId = f.customerId) {
  const result = await bookAppointment(db, {
    tenantId: f.tenantId,
    customerId,
    serviceId: f.semi,
    professionalId: f.mica,
    start: at(date, time),
    actor: 'assistant',
    now: BOOKED_AT,
  });
  if (!result.ok) throw new Error(`No se pudo reservar: ${result.reason}`);
  return result.appointmentId;
}

const list = (f: CatalogFixture, now = BOOKED_AT) =>
  runTool(listAppointmentsTool, {}, toolContext(db, f, { now }));

interface ListedAppointment {
  turnoId: string;
  opcionId: string;
  servicioId: string;
  profesionalId: string;
  servicio: string;
  profesional: string;
  fecha: string;
  estado: string;
  sena?: Record<string, string>;
  cancelarOReprogramarSinCostoHasta: string;
}

const listed = (result: Awaited<ReturnType<typeof list>>) =>
  (result.content as { turnos: ListedAppointment[] }).turnos;

describe('listar_turnos_de_la_clienta', () => {
  it('cuenta cada turno con su servicio, profesional, fecha, estado y seña, escritos por el código', async () => {
    const f = await createCatalogFixture(db);
    const id = await book(f, '2026-10-06', '10:00');

    const result = await list(f);

    expect(result.isError).toBeFalsy();
    expect(listed(result)).toEqual([
      {
        turnoId: `turno:${id}`,
        opcionId: `turno:${id}`,
        servicioId: f.semi,
        profesionalId: f.mica,
        servicio: 'Esmaltado semipermanente',
        profesional: 'Mica',
        fecha: 'martes 6/10 10:00',
        estado: 'pendiente de seña',
        sena: { monto: '$5.400', estado: 'pendiente de pago', pagarHasta: 'hoy a las 10:00', medio: 'transferencia' },
        cancelarOReprogramarSinCostoHasta: 'hasta el lunes 5/10 a las 10:00',
      },
    ]);
    expectOptionsShownToModel(result);
  });

  it('un turno confirmado sin seña no lleva datos de seña', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    await book(f, '2026-10-06', '10:00');

    const [appointment] = listed(await list(f));

    expect(appointment).toMatchObject({ estado: 'confirmado' });
    expect(appointment).not.toHaveProperty('sena');
  });

  it('con la seña en verificación o pagada dice el estado de la seña, sin plazo para pagarla', async () => {
    const f = await createCatalogFixture(db);
    const review = await book(f, '2026-10-06', '10:00');
    const paid = await book(f, '2026-10-07', '10:00');
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId: review, to: 'DEPOSIT_REVIEW', actor: 'assistant', now: BOOKED_AT });
    await db.update(deposits).set({ status: 'in_review', receiptMediaId: 'media-1' }).where(eq(deposits.appointmentId, review));
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId: paid, to: 'CONFIRMED', actor: 'owner', now: BOOKED_AT });
    await db.update(deposits).set({ status: 'approved' }).where(eq(deposits.appointmentId, paid));

    const [inReview, approved] = listed(await list(f, at('2026-10-04', '09:30')));

    expect(inReview).toMatchObject({ estado: 'seña en verificación', sena: { monto: '$5.400', estado: 'en verificación' } });
    expect(approved).toMatchObject({ estado: 'confirmado', sena: { monto: '$5.400', estado: 'pagada' } });
    expect(inReview?.sena).not.toHaveProperty('pagarHasta');
    expect(approved?.sena).not.toHaveProperty('pagarHasta');
  });

  it('dice hasta cuándo se puede cancelar o reprogramar sin costo: inicio menos el plazo del negocio', async () => {
    const f = await createCatalogFixture(db, {
      settings: { depositRequirement: 'never', freeCancellationNoticeHours: 48 },
    });
    await book(f, '2026-10-08', '15:00');

    const [appointment] = listed(await list(f));

    expect(appointment?.cancelarOReprogramarSinCostoHasta).toBe('hasta el martes 6/10 a las 15:00');
  });

  it('un turno que ya está fuera de plazo lo dice', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    await book(f, '2026-10-05', '09:00');

    // Domingo 15:00: faltan 18 horas y el plazo es de 24.
    const [appointment] = listed(await list(f, at('2026-10-04', '15:00')));

    expect(appointment?.cancelarOReprogramarSinCostoHasta).toMatch(/fuera de plazo/);
  });

  it('ofrece cada turno como opción, con un título que entra en un botón y el servicio en la descripción', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    const first = await book(f, '2026-10-05', '09:00');
    const second = await book(f, '2026-10-07', '15:30');

    const result = await list(f);

    expect(result.options).toEqual([
      { id: `turno:${first}`, title: 'lun 5/10 9:00', description: 'Esmaltado semipermanente con Mica' },
      { id: `turno:${second}`, title: 'mié 7/10 15:30', description: 'Esmaltado semipermanente con Mica' },
    ]);
    for (const option of result.options) expect(option.title.length).toBeLessThanOrEqual(20);
  });

  it('del más cercano al más lejano', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    await book(f, '2026-10-09', '09:00');
    await book(f, '2026-10-05', '09:00');
    await book(f, '2026-10-07', '09:00');

    expect(listed(await list(f)).map((appointment) => appointment.fecha)).toEqual([
      'lunes 5/10 9:00',
      'miércoles 7/10 9:00',
      'viernes 9/10 9:00',
    ]);
  });

  it('hasta 10 turnos', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    for (const day of ['05', '06', '07', '08', '09']) {
      for (const time of ['09:00', '10:30', '15:00']) await book(f, `2026-10-${day}`, time);
    }

    const result = await list(f);

    expect(listed(result)).toHaveLength(10);
    expect(result.options).toHaveLength(10);
  });

  it('sin turnos, lo dice', async () => {
    const f = await createCatalogFixture(db);

    const result = await list(f);

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual({ turnos: [], mensaje: 'La clienta no tiene turnos próximos.' });
    expect(result.options).toEqual([]);
  });

  it('no muestra los cancelados ni los de otra clienta ni los de otro negocio', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    const other = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    const cancelled = await book(f, '2026-10-05', '09:00');
    await changeAppointmentStatus(db, {
      tenantId: f.tenantId,
      appointmentId: cancelled,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: BOOKED_AT,
    });
    const mine = await book(f, '2026-10-06', '09:00');
    const otherCustomer = single(
      await db
        .insert(customers)
        .values({ tenantId: f.tenantId, phone: '+5492614555555', name: 'Otra' })
        .returning({ id: customers.id }),
    ).id;
    await book(f, '2026-10-07', '09:00', otherCustomer);
    await book(other, '2026-10-06', '09:00');

    const result = await list(f);

    expect(listed(result).map((appointment) => appointment.turnoId)).toEqual([`turno:${mine}`]);
    expect(result.options.map((option) => option.id)).toEqual([`turno:${mine}`]);
  });

  it('la clienta sale del contexto: lo que mande el modelo no cambia de quién son los turnos', async () => {
    const f = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    const other = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    await book(other, '2026-10-06', '09:00');

    const result = await runTool(
      listAppointmentsTool,
      { cliente_id: other.customerId, tenant_id: other.tenantId },
      toolContext(db, f, { now: BOOKED_AT }),
    );

    expect(listed(result)).toEqual([]);
  });
});
