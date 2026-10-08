import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { businessInfo, professionals, workingHours } from '../../src/modules/catalog/schema.js';
import { businessInfoTool } from '../../src/modules/conversation/tools/business-info.js';
import { runTool } from '../../src/modules/conversation/tools/tool.js';
import { createDatabase } from '../../src/shared/db.js';
import { createCatalogFixture, toolContext } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

type Fixture = Awaited<ReturnType<typeof createCatalogFixture>>;

const ask = (fixture: Fixture, input: unknown) => runTool(businessInfoTool, input, toolContext(db, fixture));

describe('consultar_informacion', () => {
  it.each([
    ['direccion', 'address', 'Calle Ejemplo 123'],
    ['estacionamiento', 'parking', 'Hay estacionamiento medido en la cuadra.'],
    ['medios_de_pago', 'payment_methods', 'Efectivo, transferencia y Mercado Pago.'],
    ['promociones', 'promotions', 'Los martes, 20 % en pies.'],
    ['politicas', 'policies', 'Cancelás sin cargo hasta 24 horas antes.'],
    ['cuidados', 'aftercare', 'Evitá el agua muy caliente las primeras 2 horas.'],
  ] as const)('el tema "%s" devuelve el texto cargado', async (topic, stored, text) => {
    const fixture = await createCatalogFixture(db);
    await db.insert(businessInfo).values({ tenantId: fixture.tenantId, topic: stored, content: text });

    const result = await ask(fixture, { tema: topic });

    expect(result).toEqual({ content: { tema: topic, cargado: true, texto: text }, options: [] });
  });

  it('un tema sin texto cargado se informa como "no cargado", sin inventar nada', async () => {
    const fixture = await createCatalogFixture(db);
    await db
      .insert(businessInfo)
      .values({ tenantId: fixture.tenantId, topic: 'address', content: 'Calle Ejemplo 123' });

    const result = await ask(fixture, { tema: 'estacionamiento' });

    expect(result).toEqual({ content: { tema: 'estacionamiento', cargado: false }, options: [] });
  });

  it('no devuelve el texto de otro negocio', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    await db
      .insert(businessInfo)
      .values({ tenantId: other.tenantId, topic: 'address', content: 'Dirección del otro negocio' });

    const result = await ask(mine, { tema: 'direccion' });

    expect(result.content).toEqual({ tema: 'direccion', cargado: false });
  });

  it('"horarios" se arma con el horario semanal de cada profesional activa', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await ask(fixture, { tema: 'horarios' });

    expect(result).toEqual({
      content: {
        tema: 'horarios',
        cargado: true,
        texto:
          'Mica: lunes a viernes de 9 a 13 y de 15 a 20; sábados de 9 a 13\n' +
          'Sofi: martes a sábado de 10 a 18',
      },
      options: [],
    });
  });

  it('"horarios" con el mismo horario para todas lo dice una sola vez', async () => {
    const fixture = await createCatalogFixture(db);
    await db.delete(workingHours).where(eq(workingHours.professionalId, fixture.sofi));
    await db.insert(workingHours).values(
      [1, 2, 3, 4, 5].flatMap((weekday) => [
        { tenantId: fixture.tenantId, professionalId: fixture.sofi, weekday, startTime: '09:00', endTime: '13:00' },
        { tenantId: fixture.tenantId, professionalId: fixture.sofi, weekday, startTime: '15:00', endTime: '20:00' },
      ]),
    );
    await db.insert(workingHours).values({
      tenantId: fixture.tenantId,
      professionalId: fixture.sofi,
      weekday: 6,
      startTime: '09:00',
      endTime: '13:00',
    });

    const result = await ask(fixture, { tema: 'horarios' });

    expect(result.content).toEqual({
      tema: 'horarios',
      cargado: true,
      texto: 'lunes a viernes de 9 a 13 y de 15 a 20; sábados de 9 a 13',
    });
  });

  it('"horarios" no incluye a las profesionales dadas de baja', async () => {
    const fixture = await createCatalogFixture(db);
    await db.update(professionals).set({ active: false }).where(eq(professionals.id, fixture.sofi));

    const result = await ask(fixture, { tema: 'horarios' });

    expect(result.content).toMatchObject({
      texto: 'lunes a viernes de 9 a 13 y de 15 a 20; sábados de 9 a 13',
    });
  });

  it('"horarios" sin ningún horario cargado se informa como "no cargado"', async () => {
    const fixture = await createCatalogFixture(db);
    await db.delete(workingHours).where(eq(workingHours.tenantId, fixture.tenantId));

    const result = await ask(fixture, { tema: 'horarios' });

    expect(result).toEqual({ content: { tema: 'horarios', cargado: false }, options: [] });
  });

  it('un tema que no existe es una entrada inválida', async () => {
    const fixture = await createCatalogFixture(db);

    for (const input of [{ tema: 'sueldos' }, {}]) {
      const result = await ask(fixture, input);

      expect(result.isError).toBe(true);
      expect(result.content).toMatchObject({ error: 'Entrada inválida' });
    }
  });
});
