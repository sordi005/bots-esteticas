import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { scheduleExceptions } from '../../src/modules/catalog/schema.js';
import { checkAvailabilityTool } from '../../src/modules/conversation/tools/check-availability.js';
import { parseChoiceId } from '../../src/modules/conversation/tools/choice-ids.js';
import { runTool, type OfferableOption } from '../../src/modules/conversation/tools/tool.js';
import { customers } from '../../src/modules/customers/schema.js';
import { bookAppointment } from '../../src/modules/scheduling/booking.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, toolContext, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Octubre de 2026 en Mendoza: el 4 es domingo, el 5 lunes y el 12 (lunes) es feriado.
const SUNDAY_MORNING = at('2026-10-04', '09:00');

interface Entry {
  opcionId: string;
  texto: string;
  profesional: string;
  profesionalId: string;
  inicio: string;
  duracionMinutos: number;
}

interface Availability {
  servicio?: { id: string; nombre: string };
  horarios: Entry[];
  hayMas: boolean;
  diasCerrados?: { fecha: string; motivo: string }[];
  proximoHorario?: Entry;
  reservableHasta?: string;
  mensaje?: string;
  motivo?: string;
  requiereConsulta?: boolean;
  [key: string]: unknown;
}

async function check(
  fixture: CatalogFixture,
  input: Record<string, unknown>,
  overrides: Parameters<typeof toolContext>[2] = {},
) {
  const result = await runTool(
    checkAvailabilityTool,
    { servicio_id: fixture.semi, desde: '2026-10-05', hasta: '2026-10-05', ...input },
    toolContext(db, fixture, overrides),
  );
  return { ...result, content: result.content as Availability };
}

const texts = (availability: Availability) =>
  availability.horarios.map((entry) => `${entry.texto} con ${entry.profesional}`);

describe('consultar_disponibilidad: horarios libres', () => {
  it('ofrece la primera libre y cada siguiente 90 minutos después, con más para ver', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options, isError } = await check(fixture, {});

    expect(isError).toBeUndefined();
    expect(texts(content)).toEqual([
      'lunes 5/10 9:00 con Mica',
      'lunes 5/10 10:30 con Mica',
      'lunes 5/10 12:00 con Mica',
    ]);
    expect(content.hayMas).toBe(true);
    expect(content.servicio).toEqual({ id: fixture.semi, nombre: 'Esmaltado semipermanente' });
    expect(options.map((option) => option.title)).toEqual([
      'lun 5/10 9:00',
      'lun 5/10 10:30',
      'lun 5/10 12:00',
      'Ver otros horarios',
    ]);
  });

  it('cada horario es una opción con id horario:<servicio>:<profesional>:<inicio UTC>', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options } = await check(fixture, {});

    const first = content.horarios[0];
    expect(first).toMatchObject({
      // 9:00 en Mendoza (UTC-3) es 12:00 UTC.
      inicio: '2026-10-05T12:00:00.000Z',
      profesionalId: fixture.mica,
      duracionMinutos: 60,
    });
    expect(options[0]).toEqual({
      id: `horario:${fixture.semi}:${fixture.mica}:2026-10-05T12:00:00.000Z`,
      title: 'lun 5/10 9:00',
      description: 'con Mica',
    });
    expect(first?.opcionId).toBe(options[0]?.id);
  });

  it('"ver otros horarios" lleva el servicio, la profesional (o "-") y el inicio del último ofrecido', async () => {
    const fixture = await createCatalogFixture(db);

    const anyone = await check(fixture, {});
    const specific = await check(fixture, { profesional_id: fixture.mica });

    // 12:00 en Mendoza es 15:00 UTC.
    expect(anyone.options.at(-1)).toEqual({
      id: `mas:${fixture.semi}:-:2026-10-05T15:00:00.000Z`,
      title: 'Ver otros horarios',
    });
    expect(specific.options.at(-1)?.id).toBe(`mas:${fixture.semi}:${fixture.mica}:2026-10-05T15:00:00.000Z`);
  });

  it('sin "ver otros" cuando no queda nada después del último horario ofrecido', async () => {
    const fixture = await createCatalogFixture(db);

    // El sábado Mica trabaja de 9 a 13: el último inicio es 12:00.
    const { content, options } = await check(fixture, { desde: '2026-10-10', hasta: '2026-10-10', profesional_id: fixture.mica });

    expect(texts(content)).toEqual(['sábado 10/10 9:00 con Mica', 'sábado 10/10 10:30 con Mica', 'sábado 10/10 12:00 con Mica']);
    expect(content.hayMas).toBe(false);
    expect(options.map((option) => option.title)).not.toContain('Ver otros horarios');
  });

  it('sin elegir profesional, cada horario va con la primera disponible (por nombre)', async () => {
    const fixture = await createCatalogFixture(db);

    // Martes por la tarde: Sofi trabaja de 10 a 18 y Mica desde las 15.
    const { content } = await check(fixture, { desde: '2026-10-06', hasta: '2026-10-06', franja: 'tarde' });

    expect(texts(content)).toEqual([
      'martes 6/10 13:00 con Sofi',
      'martes 6/10 14:30 con Sofi',
      'martes 6/10 16:00 con Mica',
    ]);
  });

  it('si la clienta tiene profesional preferida, es la primera cuando las dos están libres', async () => {
    const fixture = await createCatalogFixture(db);
    await db.update(customers).set({ preferredProfessionalId: fixture.sofi }).where(eq(customers.id, fixture.customerId));

    const { content } = await check(fixture, { desde: '2026-10-06', hasta: '2026-10-06', franja: 'tarde' });

    expect(texts(content)).toEqual([
      'martes 6/10 13:00 con Sofi',
      'martes 6/10 14:30 con Sofi',
      'martes 6/10 16:00 con Sofi',
    ]);
  });

  it('si pide una profesional, solo ofrece horarios de ella y con su duración', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options } = await check(fixture, {
      desde: '2026-10-06',
      hasta: '2026-10-06',
      profesional_id: fixture.sofi,
    });

    expect(texts(content)).toEqual([
      'martes 6/10 10:00 con Sofi',
      'martes 6/10 11:30 con Sofi',
      'martes 6/10 13:00 con Sofi',
    ]);
    // El semipermanente le lleva 75 minutos a Sofi.
    expect(content.horarios.map((entry) => entry.duracionMinutos)).toEqual([75, 75, 75]);
    expect(options.at(-1)?.id).toContain(`:${fixture.sofi}:`);
  });

  it('tiene en cuenta los turnos que ya están tomados', async () => {
    const fixture = await createCatalogFixture(db);
    const booked = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: fixture.customerId,
      serviceId: fixture.semi,
      professionalId: fixture.mica,
      start: at('2026-10-05', '09:00'),
      actor: 'assistant',
      now: SUNDAY_MORNING,
    });
    expect(booked.ok).toBe(true);

    const { content } = await check(fixture, {});

    // El turno ocupa de 9:00 a 10:10 (con el margen): lo primero libre es 10:15.
    expect(texts(content)).toEqual([
      'lunes 5/10 10:15 con Mica',
      'lunes 5/10 11:45 con Mica',
      'lunes 5/10 15:00 con Mica',
    ]);
  });

  it('respeta la anticipación mínima de reserva', async () => {
    const fixture = await createCatalogFixture(db);

    const { content } = await check(fixture, {}, { now: at('2026-10-05', '08:00') });

    // Son las 8:00 y hay que reservar con 2 horas de anticipación.
    expect(content.horarios[0]?.texto).toBe('lunes 5/10 10:00');
  });
});

describe('consultar_disponibilidad: franjas y rangos', () => {
  it.each([
    ['manana', ['lunes 5/10 9:00', 'lunes 5/10 10:30', 'lunes 5/10 12:00'], false],
    ['tarde', ['lunes 5/10 15:00', 'lunes 5/10 16:30'], true],
    ['noche', ['lunes 5/10 17:00', 'lunes 5/10 18:30'], true],
  ] as const)('la franja "%s" solo ofrece inicios dentro de la franja', async (franja, expected, hasMore) => {
    const fixture = await createCatalogFixture(db);

    const { content } = await check(fixture, { franja });

    expect(content.horarios.map((entry) => entry.texto)).toEqual(expected);
    expect(content.hayMas).toBe(hasMore);
    expect(content.franja).toBe(franja);
  });

  it('una franja sin lugar lo dice', async () => {
    const fixture = await createCatalogFixture(db);

    // El sábado Mica trabaja solo de mañana.
    const { content, options } = await check(fixture, {
      desde: '2026-10-10',
      hasta: '2026-10-10',
      profesional_id: fixture.mica,
      franja: 'noche',
    });

    expect(content.horarios).toEqual([]);
    expect(content.mensaje).toBe('No hay horarios libres en ese rango');
    // Lo próximo con lugar de noche: el lunes 12 es feriado, así que el martes 13 a las 17:00.
    expect(content.proximoHorario?.texto).toBe('martes 13/10 17:00');
    expect(options).toHaveLength(1);
  });

  it('busca en varios días y ofrece los primeros libres del rango', async () => {
    const fixture = await createCatalogFixture(db);
    // El domingo no se trabaja: la búsqueda arranca el domingo y sigue el lunes.
    const { content } = await check(fixture, { desde: '2026-10-11', hasta: '2026-10-13', franja: 'tarde' });

    // El lunes 12 es feriado: lo primero libre de la tarde es el martes 13.
    expect(content.horarios[0]?.texto).toBe('martes 13/10 13:00');
  });

  it('"después de" saltea lo que ya se ofreció (ver otros horarios)', async () => {
    const fixture = await createCatalogFixture(db);

    // 12:00 en Mendoza es 15:00 UTC: lo último que se ofreció el lunes a la mañana.
    const { content, options } = await check(fixture, { despues_de: '2026-10-05T15:00:00.000Z' });

    expect(content.horarios.map((entry) => entry.texto)).toEqual([
      'lunes 5/10 15:00',
      'lunes 5/10 16:30',
      'lunes 5/10 18:00',
    ]);
    expect(content.hayMas).toBe(true);
    expect(options.at(-1)?.id).toBe(`mas:${fixture.semi}:-:2026-10-05T21:00:00.000Z`);
  });
});

describe('consultar_disponibilidad: sin lugar', () => {
  it('si no hay nada en el rango, lo dice y señala el próximo horario libre como opción', async () => {
    const fixture = await createCatalogFixture(db);

    // Domingo 11: cerrado. El lunes 12 es feriado: lo próximo es el martes 13 a las 9:00.
    const { content, options, isError } = await check(fixture, { desde: '2026-10-11', hasta: '2026-10-11' });

    expect(isError).toBeUndefined();
    expect(content.horarios).toEqual([]);
    expect(content.hayMas).toBe(false);
    expect(content.mensaje).toBe('No hay horarios libres en ese rango');
    expect(content.proximoHorario).toMatchObject({
      texto: 'martes 13/10 9:00',
      profesional: 'Mica',
      inicio: '2026-10-13T12:00:00.000Z',
    });
    expect(options).toEqual([
      {
        id: `horario:${fixture.semi}:${fixture.mica}:2026-10-13T12:00:00.000Z`,
        title: 'mar 13/10 9:00',
        description: 'con Mica',
      },
    ]);
  });

  it('si ya no se puede reservar con tanta anticipación, avisa hasta cuándo sí', async () => {
    const fixture = await createCatalogFixture(db, { settings: { maxBookingAdvanceDays: 3 } });

    // Hoy es domingo 4 a las 9:00: con 3 días de anticipación máxima, se reserva hasta el miércoles 7 a las 9:00.
    const { content } = await check(fixture, { desde: '2026-10-08', hasta: '2026-10-10' });

    expect(content.horarios).toEqual([]);
    expect(content.reservableHasta).toBe('miércoles 7/10');
    expect(content.proximoHorario).toBeUndefined();
  });

  it('no avisa el límite de anticipación cuando el rango está dentro', async () => {
    const fixture = await createCatalogFixture(db);

    const { content } = await check(fixture, {});

    expect(content.reservableHasta).toBeUndefined();
  });
});

describe('consultar_disponibilidad: feriados', () => {
  it('informa el feriado en el que el negocio no trabaja, para que el modelo pueda explicarlo', async () => {
    const fixture = await createCatalogFixture(db);

    const { content } = await check(fixture, { desde: '2026-10-12', hasta: '2026-10-12' });

    expect(content.horarios).toEqual([]);
    expect(content.diasCerrados).toEqual([{ fecha: 'lunes 12/10', motivo: 'feriado: Día de la Raza' }]);
  });

  it('en un rango con feriado, ofrece los otros días y nombra el que está cerrado', async () => {
    const fixture = await createCatalogFixture(db);

    const { content } = await check(fixture, { desde: '2026-10-12', hasta: '2026-10-13' });

    expect(content.horarios[0]?.texto).toBe('martes 13/10 9:00');
    expect(content.diasCerrados).toEqual([{ fecha: 'lunes 12/10', motivo: 'feriado: Día de la Raza' }]);
  });

  it('si el negocio trabaja los feriados, hay horarios y no figura como cerrado', async () => {
    const fixture = await createCatalogFixture(db, { settings: { worksOnHolidays: true } });

    const { content } = await check(fixture, { desde: '2026-10-12', hasta: '2026-10-12' });

    expect(content.horarios[0]?.texto).toBe('lunes 12/10 9:00');
    expect(content.diasCerrados).toBeUndefined();
  });

  it('un feriado que el negocio abre con un horario especial no figura como cerrado', async () => {
    const fixture = await createCatalogFixture(db);
    await db.insert(scheduleExceptions).values({
      tenantId: fixture.tenantId,
      professionalId: null,
      kind: 'special_hours',
      timeRange: { start: at('2026-10-12', '10:00'), end: at('2026-10-12', '14:00') },
    });

    const { content } = await check(fixture, { desde: '2026-10-12', hasta: '2026-10-12' });

    expect(content.horarios[0]?.texto).toBe('lunes 12/10 10:00');
    expect(content.diasCerrados).toBeUndefined();
  });

  it('un día que no es feriado no figura como cerrado aunque no tenga lugar', async () => {
    const fixture = await createCatalogFixture(db);

    const { content } = await check(fixture, { desde: '2026-10-11', hasta: '2026-10-11' });

    expect(content.diasCerrados).toBeUndefined();
  });
});

describe('consultar_disponibilidad: lo que no se puede agendar', () => {
  it('un servicio que requiere consulta previa no devuelve horarios', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options, isError } = await check(fixture, { servicio_id: fixture.laser });

    expect(isError).toBeUndefined();
    expect(content).toMatchObject({
      requiereConsulta: true,
      motivo: 'requiere_consulta_previa',
      horarios: [],
    });
    expect(content.mensaje).toContain('consulta previa');
    expect(options).toEqual([]);
  });

  it('un servicio que no se ofrece no devuelve horarios y dice el motivo', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options } = await check(fixture, { servicio_id: fixture.hidden });

    expect(content).toMatchObject({ motivo: 'servicio_no_disponible', horarios: [] });
    expect(options).toEqual([]);
  });

  it('un servicio de otro negocio no existe para este', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);

    const { content, options, isError } = await check(mine, { servicio_id: other.semi });

    expect(isError).toBe(true);
    expect(content).toMatchObject({ motivo: 'servicio_no_encontrado' });
    expect(options).toEqual([]);
  });

  it('un servicio que no existe es un error que el modelo puede corregir', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, isError } = await check(fixture, { servicio_id: '00000000-0000-4000-8000-0000000000ff' });

    expect(isError).toBe(true);
    expect(content.motivo).toBe('servicio_no_encontrado');
  });

  it('una profesional que no hace el servicio es un error, con quiénes sí lo hacen', async () => {
    const fixture = await createCatalogFixture(db);

    // Las uñas esculpidas las hace solo Mica.
    const { content, options, isError } = await check(fixture, {
      servicio_id: fixture.sculpted,
      profesional_id: fixture.sofi,
    });

    expect(isError).toBe(true);
    expect(content).toMatchObject({
      motivo: 'profesional_no_hace_el_servicio',
      profesionalesQueLoHacen: [{ id: fixture.mica, nombre: 'Mica' }],
    });
    expect(options).toEqual([]);
  });

  it('una profesional de otro negocio tampoco sirve', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);

    const { content, isError } = await check(mine, { profesional_id: other.mica });

    expect(isError).toBe(true);
    expect(content.motivo).toBe('profesional_no_hace_el_servicio');
  });

  it('un rango de más de 7 días no llega a la base: se rechaza como entrada inválida', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, isError } = await check(fixture, { desde: '2026-10-05', hasta: '2026-10-12' });

    expect(isError).toBe(true);
    expect(content).toEqual({
      error: 'Entrada inválida',
      detalles: ['hasta: El rango no puede superar los 7 días: pedí una semana por vez'],
    });
  });

  it('el negocio y la clienta salen del contexto, no de lo que mande el modelo', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);

    // El modelo manda el negocio de otro: se ignora y el servicio ajeno no se encuentra.
    const { content, isError } = await check(mine, { servicio_id: other.semi, tenant_id: other.tenantId });

    expect(isError).toBe(true);
    expect(content.motivo).toBe('servicio_no_encontrado');
  });
});

describe('consultar_disponibilidad: las opciones se pueden ofrecer en WhatsApp', () => {
  it('títulos de hasta 20 caracteres, descripciones de hasta 72 y ids que se leen de vuelta', async () => {
    const fixture = await createCatalogFixture(db);

    const { options } = await check(fixture, {});

    expect(options.length).toBeGreaterThan(1);
    for (const option of options) {
      expect(option.title.length).toBeLessThanOrEqual(20);
      expect(option.description?.length ?? 0).toBeLessThanOrEqual(72);
      expect(option.id.length).toBeLessThanOrEqual(200);
      expect(parseChoiceId(option.id)).not.toBeNull();
    }
  });

  it('con la cantidad máxima de opciones por negocio, sumando "ver otros" no pasa de las 10 filas de una lista', async () => {
    const fixture = await createCatalogFixture(db, {
      settings: { slotsOffered: 10 },
    });

    const { options } = await check(fixture, { desde: '2026-10-05', hasta: '2026-10-11' });

    const ids: OfferableOption[] = options;
    expect(ids.length).toBeLessThanOrEqual(10);
    expect(ids.at(-1)?.title).toBe('Ver otros horarios');
  });
});
