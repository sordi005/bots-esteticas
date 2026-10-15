import { count, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { services } from '../../src/modules/catalog/schema.js';
import { checkAvailabilityTool } from '../../src/modules/conversation/tools/check-availability.js';
import { checkTimeTool } from '../../src/modules/conversation/tools/check-time.js';
import { parseChoiceId } from '../../src/modules/conversation/tools/choice-ids.js';
import { resolveChoice } from '../../src/modules/conversation/tools/choices.js';
import { runTool } from '../../src/modules/conversation/tools/tool.js';
import { customers } from '../../src/modules/customers/schema.js';
import { bookAppointment, changeAppointmentStatus } from '../../src/modules/scheduling/booking.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, toolContext, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';
import { expectOptionsShownToModel } from './support/tool-options.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Octubre de 2026 en Mendoza: el 4 es domingo, el 5 lunes y el 12 (lunes) es feriado.
// Mica: lunes a viernes de 9 a 13 y de 15 a 20, sábados de 9 a 13. Sofi: martes a sábado de 10 a 18.
const SUNDAY_MORNING = at('2026-10-04', '09:00');

interface Entry {
  opcionId: string;
  texto: string;
  profesional: string;
  profesionalId: string;
  inicio: string;
  duracionMinutos: number;
}

interface TimeCheck {
  servicio?: { id: string; nombre: string };
  libre?: boolean;
  horario?: Entry;
  consultada?: string;
  motivo?: string;
  mensaje?: string;
  horariosCercanos?: Entry[];
  proximoHorario?: Entry;
  profesionales?: { profesional: string; motivo: string }[];
  horaValidaMasCercana?: string;
  reservableDesde?: string;
  reservableHasta?: string;
  feriado?: string;
  requiereConsulta?: boolean;
  [key: string]: unknown;
}

async function checkTime(
  fixture: CatalogFixture,
  input: Record<string, unknown>,
  overrides: Parameters<typeof toolContext>[2] = {},
) {
  const ctx = toolContext(db, fixture, overrides);
  const result = await runTool(checkTimeTool, { servicio_id: fixture.semi, fecha: '2026-10-05', hora: '16:30', ...input }, ctx);
  return { ...result, content: result.content as TimeCheck, ctx };
}

/** Lo que dice cada alternativa: "lunes 5/10 17:15 con Mica". */
const alternatives = (content: TimeCheck) =>
  (content.horariosCercanos ?? []).map((entry) => `${entry.texto} con ${entry.profesional}`);

/** Cada opción que devuelve la herramienta se vuelve a resolver contra la base como un horario libre. */
async function expectEveryOptionFree(result: Awaited<ReturnType<typeof checkTime>>) {
  for (const option of result.options) {
    const resolved = await resolveChoice(db, result.ctx, option.id);
    expect(resolved, option.id).toMatchObject({ tipo: 'horario', sigueLibre: true });
  }
}

async function bookMica(fixture: CatalogFixture, date: string, time: string, customerId = fixture.customerId) {
  const booked = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId,
    serviceId: fixture.semi,
    professionalId: fixture.mica,
    start: at(date, time),
    actor: 'assistant',
    now: SUNDAY_MORNING,
  });
  if (!booked.ok) throw new Error(booked.reason);
  return booked.appointmentId;
}

async function otherCustomerId(fixture: CatalogFixture) {
  const row = single(
    await db
      .insert(customers)
      .values({ tenantId: fixture.tenantId, phone: `+54926149${String(Math.floor(Math.random() * 100_000)).padStart(5, '0')}` })
      .returning({ id: customers.id }),
  );
  return row.id;
}

describe('consultar_hora: una hora libre', () => {
  it('dice que está libre y la ofrece con el mismo formato que consultar_disponibilidad', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await checkTime(fixture, { profesional_id: fixture.mica });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      servicio: { id: fixture.semi, nombre: 'Esmaltado semipermanente' },
      libre: true,
      horario: {
        opcionId: `horario:${fixture.semi}:${fixture.mica}:2026-10-05T19:30:00.000Z`,
        texto: 'lunes 5/10 16:30',
        profesional: 'Mica',
        profesionalId: fixture.mica,
        // 16:30 en Mendoza (UTC-3) es 19:30 UTC: la conversión la hace el código.
        inicio: '2026-10-05T19:30:00.000Z',
        duracionMinutos: 60,
      },
    });
    expect(result.options).toEqual([
      {
        id: `horario:${fixture.semi}:${fixture.mica}:2026-10-05T19:30:00.000Z`,
        title: 'lun 5/10 16:30',
        description: 'con Mica',
      },
    ]);
    expectOptionsShownToModel(result);
    expect(parseChoiceId(result.options[0]?.id ?? '')).toMatchObject({ kind: 'slot', serviceId: fixture.semi });
    await expectEveryOptionFree(result);
  });

  it('una hora libre que consultar_disponibilidad no ofreció por la separación de 90 minutos, igual está libre', async () => {
    const fixture = await createCatalogFixture(db);
    // El caso que falló en la prueba manual: ofreció 9:00, 10:30 y 12:00 y la clienta preguntó por otra hora.
    const offered = await runTool(
      checkAvailabilityTool,
      { servicio_id: fixture.semi, desde: '2026-10-05', hasta: '2026-10-05' },
      toolContext(db, fixture),
    );
    expect((offered.content.horarios as Entry[]).map((entry) => entry.texto)).not.toContain('lunes 5/10 11:15');

    const result = await checkTime(fixture, { hora: '11:15' });

    expect(result.content).toMatchObject({ libre: true, horario: { texto: 'lunes 5/10 11:15', profesional: 'Mica' } });
    expect(result.options).toHaveLength(1);
  });

  it('no reserva nada: solo consulta', async () => {
    const fixture = await createCatalogFixture(db);
    const total = async () =>
      single(await db.select({ total: count() }).from(appointments).where(eq(appointments.tenantId, fixture.tenantId))).total;

    await checkTime(fixture, {});

    expect(await total()).toBe(0);
  });

  it('el último turno del bloque es el que termina justo al cierre: la duración cuenta, el margen no', async () => {
    const fixture = await createCatalogFixture(db);

    // El turno de 60 minutos que empieza 19:00 termina justo a las 20:00, cuando cierra el bloque.
    const last = await checkTime(fixture, { hora: '19:00' });
    const afterLast = await checkTime(fixture, { hora: '19:15' });

    expect(last.content.libre).toBe(true);
    expect(afterLast.content).toMatchObject({ libre: false, motivo: 'fuera_de_horario' });
  });
});

describe('consultar_hora: sin elegir profesional (4.2)', () => {
  it('si hay varias libres a esa hora, la primera por orden fijo', async () => {
    const fixture = await createCatalogFixture(db);

    // Martes 6/10 a las 11:00: Mica (9 a 13) y Sofi (10 a 18) están libres.
    const result = await checkTime(fixture, { fecha: '2026-10-06', hora: '11:00' });

    expect(result.content.horario).toMatchObject({ profesional: 'Mica', duracionMinutos: 60 });
  });

  it('si la clienta tiene una profesional preferida y está libre, esa primero', async () => {
    const fixture = await createCatalogFixture(db);
    await db.update(customers).set({ preferredProfessionalId: fixture.sofi }).where(eq(customers.id, fixture.customerId));

    const result = await checkTime(fixture, { fecha: '2026-10-06', hora: '11:00' });

    // Con la duración de Sofi: 75 minutos.
    expect(result.content.horario).toMatchObject({ profesional: 'Sofi', duracionMinutos: 75 });
    expect(result.options[0]?.id).toContain(`:${fixture.sofi}:`);
  });

  it('la preferida no gana si no está libre: sigue la que sí lo está', async () => {
    const fixture = await createCatalogFixture(db);
    await db.update(customers).set({ preferredProfessionalId: fixture.sofi }).where(eq(customers.id, fixture.customerId));

    // Martes 6/10 a las 9:30: Sofi todavía no abrió (10:00), Mica sí.
    const result = await checkTime(fixture, { fecha: '2026-10-06', hora: '09:30' });

    expect(result.content.horario).toMatchObject({ profesional: 'Mica' });
  });

  it('si la primera no está libre, sigue la que sí lo está', async () => {
    const fixture = await createCatalogFixture(db);

    // Martes 6/10 a las 13:30: Mica cierra a las 13:00 y Sofi sigue.
    const free = await checkTime(fixture, { fecha: '2026-10-06', hora: '13:30' });
    // Martes 6/10 a las 17:00: el turno de 75 minutos de Sofi no entra antes de las 18:00; el de Mica sí.
    const late = await checkTime(fixture, { fecha: '2026-10-06', hora: '17:00' });

    expect(free.content.horario).toMatchObject({ profesional: 'Sofi' });
    expect(late.content.horario).toMatchObject({ profesional: 'Mica' });
  });

  it('con Mica ocupada a esa hora, ofrece a Sofi en vez de decir que no hay lugar', async () => {
    const fixture = await createCatalogFixture(db);
    await bookMica(fixture, '2026-10-06', '11:00', await otherCustomerId(fixture));

    const result = await checkTime(fixture, { fecha: '2026-10-06', hora: '11:00' });

    expect(result.content).toMatchObject({ libre: true, horario: { profesional: 'Sofi' } });
  });
});

describe('consultar_hora: con profesional pedida', () => {
  it('solo mira a esa profesional y con su duración', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await checkTime(fixture, { fecha: '2026-10-06', hora: '11:00', profesional_id: fixture.sofi });

    expect(result.content.horario).toMatchObject({ profesional: 'Sofi', duracionMinutos: 75 });
  });

  it('si ella no tiene lugar no ofrece a otra como si fuera la hora pedida: lo dice y busca cerca con ella', async () => {
    const fixture = await createCatalogFixture(db);

    // Martes 6/10 a las 13:30 Mica no trabaja (el bloque cierra 13:00) aunque Sofi sí.
    const result = await checkTime(fixture, { fecha: '2026-10-06', hora: '13:30', profesional_id: fixture.mica });

    expect(result.content).toMatchObject({ libre: false, motivo: 'fuera_de_horario' });
    expect(new Set((result.content.horariosCercanos ?? []).map((entry) => entry.profesional))).toEqual(new Set(['Mica']));
    expect(result.content.profesionales).toBeUndefined();
  });

  it('una profesional que no hace el servicio es un error, con quiénes sí lo hacen', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options, isError } = await checkTime(fixture, {
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
});

describe('consultar_hora: una hora ocupada', () => {
  it('dice que está ocupada y ofrece los horarios libres más cercanos de ese día', async () => {
    const fixture = await createCatalogFixture(db);
    await bookMica(fixture, '2026-10-05', '16:00', await otherCustomerId(fixture));

    const result = await checkTime(fixture, { profesional_id: fixture.mica });

    expect(result.isError).toBeUndefined();
    expect(result.content).toMatchObject({
      servicio: { id: fixture.semi, nombre: 'Esmaltado semipermanente' },
      libre: false,
      consultada: 'lunes 5/10 16:30',
      motivo: 'ocupado',
    });
    expect(result.content.mensaje).toContain('ocupado');
    // Mica tiene el turno de 16:00 a 17:10: lo más cercano es 17:15, y de ahí con 90 minutos de separación.
    expect(alternatives(result.content)).toEqual([
      'lunes 5/10 12:00 con Mica',
      'lunes 5/10 17:15 con Mica',
      'lunes 5/10 18:45 con Mica',
    ]);
    expect(result.options.map((option) => option.title)).toEqual(['lun 5/10 12:00', 'lun 5/10 17:15', 'lun 5/10 18:45']);
    expectOptionsShownToModel(result);
    await expectEveryOptionFree(result);
    expect(result.content.horario).toBeUndefined();
  });

  it('el margen de un turno también ocupa: no se ofrece un horario que pisaría el del turno siguiente', async () => {
    const fixture = await createCatalogFixture(db);
    await bookMica(fixture, '2026-10-05', '17:30', await otherCustomerId(fixture));

    // 16:30 + 60 minutos + 10 de margen llega hasta 17:40 y el otro turno empieza 17:30.
    const result = await checkTime(fixture, { profesional_id: fixture.mica });

    expect(result.content).toMatchObject({ libre: false, motivo: 'ocupado' });
    expect(alternatives(result.content)).not.toContain('lunes 5/10 16:30 con Mica');
  });

  it('el propio turno de la clienta también ocupa: para moverlo hay otra herramienta', async () => {
    const fixture = await createCatalogFixture(db);
    await bookMica(fixture, '2026-10-05', '16:30');

    const result = await checkTime(fixture, { profesional_id: fixture.mica });

    expect(result.content).toMatchObject({ libre: false, motivo: 'ocupado' });
  });

  it('un turno cancelado ya no ocupa', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookMica(fixture, '2026-10-05', '16:30', await otherCustomerId(fixture));
    const changed = await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: SUNDAY_MORNING,
    });
    expect(changed.ok).toBe(true);

    const result = await checkTime(fixture, { profesional_id: fixture.mica });

    expect(result.content.libre).toBe(true);
  });

  it('con varias profesionales ocupadas o fuera de horario, el motivo es el más cercano a lograrlo y detalla a cada una', async () => {
    const fixture = await createCatalogFixture(db);
    await bookMica(fixture, '2026-10-05', '16:00', await otherCustomerId(fixture));

    // Lunes 5/10: Mica está ocupada y Sofi no trabaja los lunes.
    const result = await checkTime(fixture, {});

    expect(result.content).toMatchObject({ libre: false, motivo: 'ocupado' });
    expect(result.content.profesionales).toEqual([
      { profesional: 'Mica', motivo: 'ocupado' },
      { profesional: 'Sofi', motivo: 'dia_cerrado' },
    ]);
  });

  it('las alternativas sin elegir profesional llevan a la primera disponible de cada horario', async () => {
    const fixture = await createCatalogFixture(db);
    await bookMica(fixture, '2026-10-06', '16:00', await otherCustomerId(fixture));
    // Sofi no está libre a las 16:30 por otra clienta: martes 6/10 de 15:30 a 17:00 con ella.
    const sofiBooked = await bookAppointment(db, {
      tenantId: fixture.tenantId,
      customerId: await otherCustomerId(fixture),
      serviceId: fixture.semi,
      professionalId: fixture.sofi,
      start: at('2026-10-06', '15:30'),
      actor: 'assistant',
      now: SUNDAY_MORNING,
    });
    expect(sofiBooked.ok).toBe(true);

    const result = await checkTime(fixture, { fecha: '2026-10-06' });

    expect(result.content).toMatchObject({ libre: false, motivo: 'ocupado' });
    expect(alternatives(result.content).length).toBeGreaterThan(0);
    await expectEveryOptionFree(result);
  });
});

describe('consultar_hora: fuera del horario de atención', () => {
  it('una hora entre los dos bloques de la profesional no se atiende, y ofrece los horarios que sí', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await checkTime(fixture, { hora: '14:00' });

    expect(result.content).toMatchObject({ libre: false, motivo: 'fuera_de_horario' });
    expect(result.content.mensaje).toContain('horario de atención');
    expect(alternatives(result.content)).toEqual([
      'lunes 5/10 12:00 con Mica',
      'lunes 5/10 15:00 con Mica',
      'lunes 5/10 16:30 con Mica',
    ]);
    await expectEveryOptionFree(result);
  });

  it('una hora en que el servicio no termina antes del cierre del bloque también está fuera', async () => {
    const fixture = await createCatalogFixture(db);

    // El turno de 60 minutos que empieza 12:30 terminaría 13:30 y el bloque cierra a las 13:00.
    const result = await checkTime(fixture, { hora: '12:30' });

    expect(result.content).toMatchObject({ libre: false, motivo: 'fuera_de_horario' });
  });

  it('de madrugada y de noche', async () => {
    const fixture = await createCatalogFixture(db);

    expect((await checkTime(fixture, { hora: '06:00' })).content.motivo).toBe('fuera_de_horario');
    expect((await checkTime(fixture, { hora: '22:30' })).content.motivo).toBe('fuera_de_horario');
  });
});

describe('consultar_hora: fuera de la grilla', () => {
  it('dice que los turnos empiezan cada 15 minutos y cuál es la hora válida más cercana', async () => {
    const fixture = await createCatalogFixture(db);

    const down = await checkTime(fixture, { hora: '16:20' });
    const up = await checkTime(fixture, { hora: '16:25' });

    expect(down.content).toMatchObject({ libre: false, motivo: 'fuera_de_la_grilla', horaValidaMasCercana: '16:15' });
    expect(down.content.mensaje).toContain('15 minutos');
    expect(down.content.mensaje).toContain('16:15');
    expect(up.content).toMatchObject({ motivo: 'fuera_de_la_grilla', horaValidaMasCercana: '16:30' });
    expect(alternatives(down.content).length).toBeGreaterThan(0);
    await expectEveryOptionFree(down);
  });

  it('la grilla es la del negocio', async () => {
    const fixture = await createCatalogFixture(db, { settings: { slotGranularityMinutes: 30 } });

    const result = await checkTime(fixture, { hora: '16:15' });

    expect(result.content).toMatchObject({ motivo: 'fuera_de_la_grilla', horaValidaMasCercana: '16:30' });
    expect(result.content.mensaje).toContain('30 minutos');
  });
});

describe('consultar_hora: anticipación', () => {
  it('sin la anticipación mínima, dice desde cuándo se puede reservar y ofrece lo que sigue ese día', async () => {
    const fixture = await createCatalogFixture(db);

    // Es lunes 5/10 a las 8:00 y hay que reservar con 2 horas de anticipación.
    const result = await checkTime(fixture, { hora: '09:30' }, { now: at('2026-10-05', '08:00') });

    expect(result.content).toMatchObject({
      libre: false,
      motivo: 'sin_anticipacion_minima',
      reservableDesde: 'lunes 5/10 10:00',
    });
    expect(result.content.mensaje).toContain('anticipación');
    expect(alternatives(result.content)[0]).toBe('lunes 5/10 10:00 con Mica');
    await expectEveryOptionFree(result);
  });

  it('justo con la anticipación mínima, está libre', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await checkTime(fixture, { hora: '10:00' }, { now: at('2026-10-05', '08:00') });

    expect(result.content.libre).toBe(true);
  });

  it('un horario que ya pasó lo dice así', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await checkTime(fixture, { hora: '16:30' }, { now: at('2026-10-05', '17:00') });

    expect(result.content).toMatchObject({ libre: false, motivo: 'sin_anticipacion_minima' });
    expect(result.content.mensaje).toContain('ya pasó');
  });

  it('más allá de la anticipación máxima, dice hasta cuándo se reserva y no inventa horarios', async () => {
    const fixture = await createCatalogFixture(db);

    // Hoy es domingo 4/10 a las 9:00: con 30 días de anticipación se reserva hasta el martes 3/11 a las 9:00.
    const result = await checkTime(fixture, { fecha: '2026-11-10', hora: '16:30' });

    expect(result.content).toMatchObject({
      libre: false,
      motivo: 'mas_alla_de_la_anticipacion_maxima',
      reservableHasta: 'martes 3/11',
    });
    expect(result.content.horariosCercanos).toEqual([]);
    expect(result.options).toEqual([]);
  });

  it('el último instante que se puede reservar está libre y el siguiente no', async () => {
    const fixture = await createCatalogFixture(db);

    expect((await checkTime(fixture, { fecha: '2026-11-03', hora: '09:00' })).content.libre).toBe(true);
    expect((await checkTime(fixture, { fecha: '2026-11-03', hora: '09:15' })).content.motivo).toBe(
      'mas_alla_de_la_anticipacion_maxima',
    );
  });
});

describe('consultar_hora: feriados y días cerrados', () => {
  it('un feriado en que el negocio no trabaja: lo dice con su nombre y señala el próximo horario libre', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await checkTime(fixture, { fecha: '2026-10-12' });

    expect(result.content).toMatchObject({ libre: false, motivo: 'feriado', feriado: 'Día de la Raza' });
    expect(result.content.mensaje).toContain('Día de la Raza');
    expect(result.content.horariosCercanos).toEqual([]);
    expect(result.content.proximoHorario).toMatchObject({ texto: 'martes 13/10 9:00', profesional: 'Mica' });
    expect(result.options).toHaveLength(1);
    expectOptionsShownToModel(result);
    await expectEveryOptionFree(result);
  });

  it('si el negocio trabaja los feriados, el feriado es un día común', async () => {
    const fixture = await createCatalogFixture(db, { settings: { worksOnHolidays: true } });

    const result = await checkTime(fixture, { fecha: '2026-10-12' });

    expect(result.content.libre).toBe(true);
  });

  it('un día sin atención (domingo) es un día cerrado, no un feriado', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await checkTime(fixture, { fecha: '2026-10-11', hora: '10:00' });

    expect(result.content).toMatchObject({ libre: false, motivo: 'dia_cerrado' });
    expect(result.content.feriado).toBeUndefined();
    expect(result.content.mensaje).toContain('no hay atención');
    // El lunes 12 es feriado: lo próximo es el martes 13.
    expect(result.content.proximoHorario).toMatchObject({ texto: 'martes 13/10 9:00' });
  });
});

describe('consultar_hora: lo que no se puede agendar', () => {
  it('un servicio que requiere consulta previa no se agenda: dice el motivo y no ofrece nada', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options, isError } = await checkTime(fixture, { servicio_id: fixture.laser });

    expect(isError).toBeUndefined();
    expect(content).toMatchObject({ libre: false, requiereConsulta: true, motivo: 'requiere_consulta_previa' });
    expect(content.mensaje).toContain('consulta previa');
    expect(options).toEqual([]);
  });

  it('un servicio que no se ofrece no se agenda por este medio', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, options } = await checkTime(fixture, { servicio_id: fixture.hidden });

    expect(content).toMatchObject({ libre: false, motivo: 'servicio_no_disponible' });
    expect(options).toEqual([]);
  });

  it('un servicio que dejó de ofrecerse se ve igual que uno que nunca se ofreció', async () => {
    const fixture = await createCatalogFixture(db);
    await db.update(services).set({ visible: false }).where(eq(services.id, fixture.semi));

    const { content } = await checkTime(fixture, {});

    expect(content).toMatchObject({ libre: false, motivo: 'servicio_no_disponible' });
  });

  it('un servicio de otro negocio no existe para este', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);

    const { content, options, isError } = await checkTime(mine, { servicio_id: other.semi });

    expect(isError).toBe(true);
    expect(content.motivo).toBe('servicio_no_encontrado');
    expect(options).toEqual([]);
  });

  it('el negocio y la clienta salen del contexto, no de lo que mande el modelo', async () => {
    const mine = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);

    const { content, isError } = await checkTime(mine, { servicio_id: other.semi, tenant_id: other.tenantId });

    expect(isError).toBe(true);
    expect(content.motivo).toBe('servicio_no_encontrado');
  });
});

describe('consultar_hora: entradas inválidas', () => {
  it.each([
    ['una hora sin cero adelante', { hora: '9:30' }, 'hora'],
    ['una hora que no existe', { hora: '25:00' }, 'hora'],
    ['una hora en palabras', { hora: 'a la tarde' }, 'hora'],
    ['una fecha con otro formato', { fecha: '5/10/2026' }, 'fecha'],
    ['una fecha que no existe', { fecha: '2026-02-30' }, 'fecha'],
  ])('%s no llega a la base: es un error que el modelo puede corregir', async (_description, input, field) => {
    const fixture = await createCatalogFixture(db);

    const { content, options, isError } = await checkTime(fixture, input);

    expect(isError).toBe(true);
    expect(options).toEqual([]);
    expect(content.error).toBe('Entrada inválida');
    expect(JSON.stringify(content.detalles)).toContain(field);
  });

  it('sin hora no hay qué consultar', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await runTool(
      checkTimeTool,
      { servicio_id: fixture.semi, fecha: '2026-10-05' },
      toolContext(db, fixture),
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('hora');
  });

  it('sin servicio no hay qué consultar: el esquema lo rechaza antes de tocar la base', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await runTool(
      checkTimeTool,
      { fecha: '2026-10-05', hora: '16:30' },
      toolContext(db, fixture),
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('servicio_id');
  });
});
