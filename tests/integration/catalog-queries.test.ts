import { afterAll, describe, expect, it } from 'vitest';
import {
  getBusinessInfo,
  getWeeklyHours,
  listHolidays,
  listVisibleServices,
} from '../../src/modules/catalog/queries.js';
import {
  businessInfo,
  professionals,
  professionalServices,
  services,
  workingHours,
} from '../../src/modules/catalog/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

async function addProfessional(tenantId: string, name: string, options: { active?: boolean } = {}) {
  return single(
    await db
      .insert(professionals)
      .values({ tenantId, name, active: options.active ?? true })
      .returning({ id: professionals.id }),
  ).id;
}

async function addService(tenantId: string, values: Partial<typeof services.$inferInsert> & { name: string }) {
  return single(
    await db
      .insert(services)
      .values({ tenantId, category: 'Manos', durationMinutes: 30, priceCents: 500_000, ...values })
      .returning({ id: services.id }),
  ).id;
}

describe('listVisibleServices: el catálogo que ve el asistente', () => {
  it('trae solo los servicios visibles, ordenados por categoría y nombre', async () => {
    const { tenantId } = await createBookableFixture(db);
    await addService(tenantId, { name: 'Perfilado de cejas', category: 'Cejas' });
    await addService(tenantId, { name: 'Servicio escondido', category: 'Cejas', visible: false });
    await addService(tenantId, { name: 'Retiro', category: 'Manos' });

    const catalog = await listVisibleServices(db, tenantId);

    expect(catalog.map((service) => `${service.category} / ${service.name}`)).toEqual([
      'Cejas / Perfilado de cejas',
      'Manos / Esmaltado semipermanente',
      'Manos / Retiro',
    ]);
  });

  it('trae los datos del servicio tal como están cargados', async () => {
    const fixture = await createBookableFixture(db, {
      service: { aliases: ['semi'], priceType: 'from', requiresConsultation: true },
    });

    const [service] = await listVisibleServices(db, fixture.tenantId);

    expect(service).toMatchObject({
      id: fixture.serviceId,
      name: 'Esmaltado semipermanente',
      aliases: ['semi'],
      category: 'Manos',
      durationMinutes: 60,
      bufferMinutes: 10,
      priceCents: 1_800_000,
      cashPriceCents: 1_600_000,
      priceType: 'from',
      requiresConsultation: true,
    });
  });

  it('cada servicio trae sus profesionales activas, con la duración propia si la tienen', async () => {
    const fixture = await createBookableFixture(db, { durationOverrideMinutes: 75 });
    const sofi = await addProfessional(fixture.tenantId, 'Sofi');
    await db
      .insert(professionalServices)
      .values({ tenantId: fixture.tenantId, professionalId: sofi, serviceId: fixture.serviceId });
    const retired = await addProfessional(fixture.tenantId, 'Ana', { active: false });
    await db
      .insert(professionalServices)
      .values({ tenantId: fixture.tenantId, professionalId: retired, serviceId: fixture.serviceId });

    const [service] = await listVisibleServices(db, fixture.tenantId);

    expect(service?.professionals).toEqual([
      { id: fixture.professionalId, name: 'Mica', durationOverrideMinutes: 75 },
      { id: sofi, name: 'Sofi', durationOverrideMinutes: null },
    ]);
  });

  it('un servicio sin profesionales activas igual figura, con la lista vacía', async () => {
    const { tenantId } = await createBookableFixture(db);
    await addService(tenantId, { name: 'Sin nadie que lo haga', category: 'Zeta' });

    const catalog = await listVisibleServices(db, tenantId);

    expect(catalog.find((service) => service.name === 'Sin nadie que lo haga')?.professionals).toEqual([]);
  });

  it('no ve los servicios ni las profesionales de otro negocio', async () => {
    const mine = await createBookableFixture(db);
    const other = await createBookableFixture(db);
    await addService(other.tenantId, { name: 'Solo del otro negocio' });

    const catalog = await listVisibleServices(db, mine.tenantId);

    expect(catalog.map((service) => service.id)).toEqual([mine.serviceId]);
    expect(catalog[0]?.professionals.map((professional) => professional.id)).toEqual([
      mine.professionalId,
    ]);
  });
});

describe('getBusinessInfo: los textos que carga la dueña', () => {
  it('devuelve el texto del tema, o null si no está cargado', async () => {
    const { tenantId } = await createBookableFixture(db);
    await db.insert(businessInfo).values({ tenantId, topic: 'address', content: 'Calle Ejemplo 123' });

    expect(await getBusinessInfo(db, tenantId, 'address')).toBe('Calle Ejemplo 123');
    expect(await getBusinessInfo(db, tenantId, 'parking')).toBeNull();
  });

  it('no ve el texto de otro negocio', async () => {
    const mine = await createBookableFixture(db);
    const other = await createBookableFixture(db);
    await db
      .insert(businessInfo)
      .values({ tenantId: other.tenantId, topic: 'address', content: 'Dirección del otro' });

    expect(await getBusinessInfo(db, mine.tenantId, 'address')).toBeNull();
  });
});

describe('getWeeklyHours: el horario semanal de las profesionales activas', () => {
  it('trae los bloques de cada profesional activa, ordenadas por nombre', async () => {
    const fixture = await createBookableFixture(db);
    const sofi = await addProfessional(fixture.tenantId, 'Sofi');
    await db.insert(workingHours).values({
      tenantId: fixture.tenantId,
      professionalId: sofi,
      weekday: 2,
      startTime: '10:00',
      endTime: '18:00',
    });
    const retired = await addProfessional(fixture.tenantId, 'Ana', { active: false });
    await db.insert(workingHours).values({
      tenantId: fixture.tenantId,
      professionalId: retired,
      weekday: 1,
      startTime: '09:00',
      endTime: '13:00',
    });

    const team = await getWeeklyHours(db, fixture.tenantId);

    expect(team.map((professional) => professional.name)).toEqual(['Mica', 'Sofi']);
    expect(team[1]?.blocks).toEqual([{ weekday: 2, start: '10:00:00', end: '18:00:00' }]);
    // Mica: lunes a viernes en dos bloques, más el sábado.
    expect(team[0]?.blocks).toHaveLength(11);
  });

  it('una profesional activa sin horario figura con la lista vacía', async () => {
    const { tenantId } = await createBookableFixture(db);
    await addProfessional(tenantId, 'Zoe');

    const team = await getWeeklyHours(db, tenantId);

    expect(team.find((professional) => professional.name === 'Zoe')?.blocks).toEqual([]);
  });

  it('no ve las profesionales de otro negocio', async () => {
    const mine = await createBookableFixture(db);
    const other = await createBookableFixture(db);
    await addProfessional(other.tenantId, 'Solo del otro');

    const team = await getWeeklyHours(db, mine.tenantId);

    expect(team.map((professional) => professional.id)).toEqual([mine.professionalId]);
  });
});

describe('listHolidays: feriados nacionales de un rango de fechas', () => {
  it('trae los del rango, ambos extremos incluidos', async () => {
    const found = await listHolidays(db, '2026-10-12', '2026-10-12');

    expect(found).toEqual([{ date: '2026-10-12', name: 'Día de la Raza' }]);
  });

  it('un rango sin feriados devuelve vacío', async () => {
    expect(await listHolidays(db, '2026-10-13', '2026-10-19')).toEqual([]);
  });

  it('varios feriados salen en orden de fecha', async () => {
    const dates = (await listHolidays(db, '2026-05-01', '2026-06-30')).map((holiday) => holiday.date);

    expect(dates).toEqual(['2026-05-01', '2026-05-25', '2026-06-15', '2026-06-20']);
  });
});
