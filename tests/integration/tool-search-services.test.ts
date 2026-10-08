import { afterAll, describe, expect, it } from 'vitest';
import { services } from '../../src/modules/catalog/schema.js';
import { searchServicesTool } from '../../src/modules/conversation/tools/search-services.js';
import { runTool } from '../../src/modules/conversation/tools/tool.js';
import { createDatabase } from '../../src/shared/db.js';
import { createCatalogFixture, toolContext } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

interface FoundService {
  id: string;
  nombre: string;
  precio: string;
  precioEfectivo: string | null;
  tipoPrecio: string;
  precioTexto: string;
  duracionMinutos: number;
  duracionTexto: string;
  requiereConsultaPrevia: boolean;
  profesionales: { nombre: string; duracionMinutos: number }[];
}

async function search(fixture: Awaited<ReturnType<typeof createCatalogFixture>>, input: unknown) {
  const result = await runTool(searchServicesTool, input, toolContext(db, fixture));
  const content = result.content as { coincidencias: FoundService[]; [key: string]: unknown };
  return { ...result, content };
}

describe('buscar_servicios', () => {
  it('con un alias encuentra el servicio con sus precios y duraciones escritos', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options, isError } = await search(fixture, { texto: 'semi' });

    expect(isError).toBeUndefined();
    expect(content.coincidencias).toHaveLength(1);
    expect(content.coincidencias[0]).toMatchObject({
      id: fixture.semi,
      nombre: 'Esmaltado semipermanente',
      precio: '$18.000',
      precioEfectivo: '$16.000',
      tipoPrecio: 'fijo',
      precioTexto: '$18.000 ($16.000 en efectivo o transferencia)',
      duracionMinutos: 60,
      duracionTexto: '60 min (con Sofi, 75 min)',
      requiereConsultaPrevia: false,
      profesionales: [
        { nombre: 'Mica', duracionMinutos: 60 },
        { nombre: 'Sofi', duracionMinutos: 75 },
      ],
    });
    expect(options).toEqual([
      {
        id: `servicio:${fixture.semi}`,
        title: 'Esmaltado…',
        description: 'Esmaltado semipermanente · $18.000 · 60 min',
      },
    ]);
  });

  it('un servicio con precio "desde" lo aclara en el contenido', async () => {
    const fixture = await createCatalogFixture(db);

    const { content } = await search(fixture, { texto: 'esculpidas' });

    expect(content.coincidencias[0]).toMatchObject({
      nombre: 'Uñas esculpidas',
      precio: '$28.000',
      tipoPrecio: 'desde',
      precioTexto:
        'desde $28.000 (desde $25.000 en efectivo o transferencia), el precio final lo confirma la profesional',
    });
  });

  it('no distingue tildes ni mayúsculas, y marca el servicio que requiere consulta previa', async () => {
    const fixture = await createCatalogFixture(db);

    const { content } = await search(fixture, { texto: 'DEPILACION' });

    expect(content.coincidencias).toHaveLength(1);
    expect(content.coincidencias[0]).toMatchObject({
      id: fixture.laser,
      requiereConsultaPrevia: true,
      precioEfectivo: null,
    });
  });

  it('sin texto devuelve el catálogo visible completo, sin los servicios ocultos', async () => {
    const fixture = await createCatalogFixture(db);

    for (const input of [{}, { texto: '   ' }]) {
      const { content, options } = await search(fixture, input);

      expect(content.coincidencias.map((service) => service.nombre)).toEqual([
        'Depilación láser',
        'Esmaltado semipermanente',
        'Uñas esculpidas',
        'Semipermanente en pies',
      ]);
      expect(options.map((option) => option.id)).toEqual(
        content.coincidencias.map((service) => `servicio:${service.id}`),
      );
    }
  });

  it('un servicio que no se ofrece no se encuentra, ni por su nombre', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options } = await search(fixture, { texto: 'Servicio que no se ofrece' });

    expect(content.coincidencias).toEqual([]);
    expect(options).toEqual([]);
  });

  it('si no está en el catálogo, lo dice y lista lo que sí hay para orientar', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options, isError } = await search(fixture, { texto: 'botox' });

    expect(isError).toBeUndefined();
    expect(content).toEqual({
      coincidencias: [],
      mensaje: 'No está en el catálogo',
      serviciosDisponibles: [
        'Depilación láser',
        'Esmaltado semipermanente',
        'Uñas esculpidas',
        'Semipermanente en pies',
      ],
    });
    expect(options).toEqual([]);
  });

  it('no ve los servicios de otro negocio', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    await db.insert(services).values({
      tenantId: other.tenantId,
      name: 'Solo del otro negocio',
      category: 'Otros',
      durationMinutes: 30,
      priceCents: 100,
    });

    const { content } = await search(mine, { texto: 'solo del otro negocio' });

    expect(content.coincidencias).toEqual([]);
    const ids = (await search(mine, {})).content.coincidencias.map((service) => service.id);
    expect(ids).not.toContain(other.semi);
  });

  it('las opciones son como mucho 10 (una lista de WhatsApp) y avisa si hay más', async () => {
    const fixture = await createCatalogFixture(db);
    await db.insert(services).values(
      Array.from({ length: 8 }, (_, index) => ({
        tenantId: fixture.tenantId,
        name: `Servicio extra ${String(index + 1)}`,
        category: 'Zeta',
        durationMinutes: 30,
        priceCents: 100_000,
      })),
    );

    const { content, options } = await search(fixture, {});

    expect(options).toHaveLength(10);
    expect(content.coincidencias).toHaveLength(10);
    expect(content).toMatchObject({ total: 12, hayMas: true });
  });

  it('los títulos de las opciones entran en un botón (20 caracteres)', async () => {
    const fixture = await createCatalogFixture(db);

    const { options } = await search(fixture, {});

    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.title.length).toBeLessThanOrEqual(20);
      expect(option.description?.length ?? 0).toBeLessThanOrEqual(72);
    }
  });

  it('un texto demasiado largo se rechaza como entrada inválida', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await runTool(searchServicesTool, { texto: 'a'.repeat(201) }, toolContext(db, fixture));

    expect(result.isError).toBe(true);
  });
});
