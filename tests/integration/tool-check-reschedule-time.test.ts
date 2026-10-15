import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { services } from '../../src/modules/catalog/schema.js';
import { checkRescheduleAvailabilityTool } from '../../src/modules/conversation/tools/check-reschedule-availability.js';
import { checkRescheduleTimeTool } from '../../src/modules/conversation/tools/check-reschedule-time.js';
import { parseChoiceId } from '../../src/modules/conversation/tools/choice-ids.js';
import { resolveChoice } from '../../src/modules/conversation/tools/choices.js';
import { runTool } from '../../src/modules/conversation/tools/tool.js';
import { customers } from '../../src/modules/customers/schema.js';
import { bookAppointment, changeAppointmentStatus } from '../../src/modules/scheduling/booking.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, toolContext, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';
import { expectOptionsShownToModel } from './support/tool-options.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Octubre de 2026 en Mendoza: el 4 es domingo, el 5 lunes, el 6 martes y el 12 (lunes) es feriado.
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

interface RescheduleTimeCheck {
  servicio?: { id: string; nombre: string };
  turno?: { turnoId: string; actual: string };
  libre?: boolean;
  horario?: Entry;
  consultada?: string;
  motivo?: string;
  mensaje?: string;
  horariosCercanos?: Entry[];
  proximoHorario?: Entry;
  [key: string]: unknown;
}

/** Otra clienta del mismo negocio. */
async function otherCustomerId(fixture: CatalogFixture) {
  const row = single(
    await db
      .insert(customers)
      .values({ tenantId: fixture.tenantId, phone: `+54926149${String(Math.floor(Math.random() * 100_000)).padStart(5, '0')}` })
      .returning({ id: customers.id }),
  );
  return row.id;
}

/** Reserva un turno (por defecto, de la clienta: semi con Mica el martes 6/10 a las 10:00). */
async function bookTurn(
  fixture: CatalogFixture,
  input: { customerId?: string; professionalId?: string; serviceId?: string; start?: Date } = {},
) {
  const booked = await bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId: input.customerId ?? fixture.customerId,
    serviceId: input.serviceId ?? fixture.semi,
    professionalId: input.professionalId ?? fixture.mica,
    start: input.start ?? at('2026-10-06', '10:00'),
    actor: 'assistant',
    now: SUNDAY_MORNING,
  });
  if (!booked.ok) throw new Error(booked.reason);
  return booked.appointmentId;
}

async function checkToMove(
  fixture: CatalogFixture,
  turnoId: string,
  input: Record<string, unknown> = {},
  overrides: Parameters<typeof toolContext>[2] = {},
) {
  const ctx = toolContext(db, fixture, overrides);
  const result = await runTool(
    checkRescheduleTimeTool,
    { turno_id: turnoId, fecha: '2026-10-07', hora: '16:30', ...input },
    ctx,
  );
  return { ...result, content: result.content as RescheduleTimeCheck, ctx };
}

const alternatives = (content: RescheduleTimeCheck) =>
  (content.horariosCercanos ?? []).map((entry) => `${entry.texto} con ${entry.profesional}`);

/** Cada opción que devuelve la herramienta se vuelve a resolver contra la base como un horario libre para ese turno. */
async function expectEveryOptionFree(result: Awaited<ReturnType<typeof checkToMove>>, appointmentId: string) {
  expect(result.options.length).toBeGreaterThan(0);
  for (const option of result.options) {
    expect(parseChoiceId(option.id), option.id).toMatchObject({ kind: 'reschedule', appointmentId });
    const resolved = await resolveChoice(db, result.ctx, option.id);
    expect(resolved, option.id).toMatchObject({ tipo: 'reprogramar', sigueLibre: true });
  }
}

describe('consultar_hora_para_reprogramar: una hora libre', () => {
  it('dice que está libre y la ofrece con un id reprogramar:<turno>:<inicio>, con el turno que se mueve y su servicio', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const result = await checkToMove(fixture, appointmentId);

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      servicio: { id: fixture.semi, nombre: 'Esmaltado semipermanente' },
      turno: { turnoId: `turno:${appointmentId}`, actual: 'martes 6/10 10:00' },
      libre: true,
      horario: {
        opcionId: `reprogramar:${appointmentId}:2026-10-07T19:30:00.000Z`,
        texto: 'miércoles 7/10 16:30',
        profesional: 'Mica',
        profesionalId: fixture.mica,
        // 16:30 en Mendoza (UTC-3) es 19:30 UTC: la conversión la hace el código.
        inicio: '2026-10-07T19:30:00.000Z',
        duracionMinutos: 60,
      },
    });
    expect(result.options).toEqual([
      { id: `reprogramar:${appointmentId}:2026-10-07T19:30:00.000Z`, title: 'mié 7/10 16:30', description: 'con Mica' },
    ]);
    expectOptionsShownToModel(result);
    await expectEveryOptionFree(result, appointmentId);
  });

  it('una hora que consultar_horarios_para_reprogramar no ofreció por la separación de 90 minutos, igual está libre', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);
    const offered = await runTool(
      checkRescheduleAvailabilityTool,
      { turno_id: appointmentId, desde: '2026-10-07', hasta: '2026-10-07' },
      toolContext(db, fixture),
    );
    expect((offered.content.horarios as Entry[]).map((entry) => entry.texto)).not.toContain('miércoles 7/10 11:15');

    const result = await checkToMove(fixture, appointmentId, { hora: '11:15' });

    expect(result.content).toMatchObject({ libre: true, horario: { texto: 'miércoles 7/10 11:15' } });
  });

  it('acepta el turno con el prefijo turno: o el uuid solo', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const withPrefix = await checkToMove(fixture, `turno:${appointmentId}`);
    const bare = await checkToMove(fixture, appointmentId);

    expect(withPrefix.isError).toBeUndefined();
    expect(withPrefix.content).toEqual(bare.content);
  });

  it('el propio turno no ocupa lugar: una hora que lo pisaría está libre', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    // El turno es martes 6/10 de 10:00 a 11:10: las 9:30 lo pisarían si se lo contara como ocupado.
    const result = await checkToMove(fixture, appointmentId, { fecha: '2026-10-06', hora: '09:30' });

    expect(result.content).toMatchObject({ libre: true, horario: { texto: 'martes 6/10 9:30' } });
  });

  it('el servicio y la profesional son los del turno: con el turno de Sofi, la hora es con Sofi y con sus 75 minutos', async () => {
    const fixture = await createCatalogFixture(db);
    // Sofi hace el semi en 75 minutos y Mica también lo hace: el turno es de Sofi.
    const appointmentId = await bookTurn(fixture, { professionalId: fixture.sofi, start: at('2026-10-06', '11:00') });

    // Miércoles 7/10 a las 11:00 Mica también está libre, pero se mueve el turno de Sofi.
    const result = await checkToMove(fixture, appointmentId, { hora: '11:00' });

    expect(result.content.horario).toMatchObject({ profesional: 'Sofi', duracionMinutos: 75 });
  });

  it('no se puede cambiar de profesional hablando: lo que mande el modelo de servicio o de profesional se ignora', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const result = await checkToMove(fixture, appointmentId, {
      servicio_id: fixture.sculpted,
      profesional_id: fixture.sofi,
    });

    expect(result.content).toMatchObject({
      servicio: { id: fixture.semi },
      libre: true,
      horario: { profesional: 'Mica' },
    });
  });

  it('un servicio que después dejó de ofrecerse o que ahora requiere consulta previa igual se puede reprogramar', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);
    await db.update(services).set({ visible: false, requiresConsultation: true }).where(eq(services.id, fixture.semi));

    const result = await checkToMove(fixture, appointmentId);

    expect(result.isError).toBeUndefined();
    expect(result.content.libre).toBe(true);
  });
});

describe('consultar_hora_para_reprogramar: la misma hora del turno', () => {
  it('dice que ya es el horario del turno, no la ofrece y trae otros horarios cercanos', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const result = await checkToMove(fixture, appointmentId, { fecha: '2026-10-06', hora: '10:00' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toMatchObject({
      libre: false,
      motivo: 'misma_hora_del_turno',
      turno: { actual: 'martes 6/10 10:00' },
    });
    expect(result.content.mensaje).toContain('ya es el horario del turno');
    expect(result.content.horario).toBeUndefined();
    expect(alternatives(result.content)).not.toContain('martes 6/10 10:00 con Mica');
    expect(result.content.horariosCercanos?.length).toBeGreaterThan(0);
    expectOptionsShownToModel(result);
    await expectEveryOptionFree(result, appointmentId);
  });

  it('la misma hora de otro día no es la del turno', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const result = await checkToMove(fixture, appointmentId, { fecha: '2026-10-07', hora: '10:00' });

    expect(result.content.libre).toBe(true);
  });
});

describe('consultar_hora_para_reprogramar: una hora que no se puede', () => {
  it('ocupada por otro turno de la profesional: lo dice y ofrece ids reprogramar: cercanos', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);
    // De otra clienta, el miércoles 7/10 de 16:00 a 17:10.
    await bookTurn(fixture, { customerId: await otherCustomerId(fixture), start: at('2026-10-07', '16:00') });

    const result = await checkToMove(fixture, appointmentId);

    expect(result.content).toMatchObject({
      libre: false,
      consultada: 'miércoles 7/10 16:30',
      motivo: 'ocupado',
      servicio: { id: fixture.semi },
      turno: { actual: 'martes 6/10 10:00' },
    });
    expect(alternatives(result.content)).toEqual([
      'miércoles 7/10 12:00 con Mica',
      'miércoles 7/10 17:15 con Mica',
      'miércoles 7/10 18:45 con Mica',
    ]);
    expectOptionsShownToModel(result);
    await expectEveryOptionFree(result, appointmentId);
  });

  it('usa la duración del turno, no la actual del servicio: a las 12:30 no entra en el bloque', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);
    await db.update(services).set({ durationMinutes: 30, bufferMinutes: 0 }).where(eq(services.id, fixture.semi));

    // Con 30 minutos terminaría 13:00 justo; con los 60 del turno, 13:30, después de cerrar el bloque de Mica.
    const result = await checkToMove(fixture, appointmentId, { hora: '12:30' });

    expect(result.content).toMatchObject({ libre: false, motivo: 'fuera_de_horario' });
    expect(new Set((result.content.horariosCercanos ?? []).map((entry) => entry.duracionMinutos))).toEqual(new Set([60]));
  });

  it('con la profesional del turno: si ella no trabaja a esa hora no se pasa a otra', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    // Miércoles 7/10 a las 13:30 Mica no trabaja (el bloque cierra a las 13:00), aunque Sofi sí.
    const result = await checkToMove(fixture, appointmentId, { hora: '13:30' });

    expect(result.content).toMatchObject({ libre: false, motivo: 'fuera_de_horario' });
    expect(result.content.profesionales).toBeUndefined();
    expect(new Set((result.content.horariosCercanos ?? []).map((entry) => entry.profesional))).toEqual(new Set(['Mica']));
  });

  it('fuera de la grilla, con la hora válida más cercana', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const result = await checkToMove(fixture, appointmentId, { hora: '16:20' });

    expect(result.content).toMatchObject({ libre: false, motivo: 'fuera_de_la_grilla', horaValidaMasCercana: '16:15' });
    await expectEveryOptionFree(result, appointmentId);
  });

  it('sin la anticipación mínima y más allá de la anticipación máxima', async () => {
    // Sin seña, para que el turno siga ocupando horario aunque la consulta sea tres días después de reservarlo.
    const fixture = await createCatalogFixture(db, { settings: { depositRequirement: 'never' } });
    const appointmentId = await bookTurn(fixture);

    const soon = await checkToMove(fixture, appointmentId, { hora: '09:30' }, { now: at('2026-10-07', '08:00') });
    const far = await checkToMove(fixture, appointmentId, { fecha: '2026-11-10' });

    expect(soon.content).toMatchObject({ motivo: 'sin_anticipacion_minima', reservableDesde: 'miércoles 7/10 10:00' });
    expect(far.content).toMatchObject({ motivo: 'mas_alla_de_la_anticipacion_maxima', reservableHasta: 'martes 3/11' });
    expect(far.options).toEqual([]);
  });

  it('un feriado: lo dice con su nombre y señala el próximo horario libre para mover el turno', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const result = await checkToMove(fixture, appointmentId, { fecha: '2026-10-12' });

    expect(result.content).toMatchObject({ libre: false, motivo: 'feriado', feriado: 'Día de la Raza' });
    expect(result.content.proximoHorario).toMatchObject({
      opcionId: `reprogramar:${appointmentId}:2026-10-13T12:00:00.000Z`,
      texto: 'martes 13/10 9:00',
    });
    expectOptionsShownToModel(result);
  });

  it('un día sin atención es un día cerrado', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const result = await checkToMove(fixture, appointmentId, { fecha: '2026-10-11', hora: '10:00' });

    expect(result.content).toMatchObject({ libre: false, motivo: 'dia_cerrado' });
  });
});

describe('consultar_hora_para_reprogramar: solo el turno de la clienta que escribe, y que todavía ocupa horario', () => {
  it('el turno de otra clienta del mismo negocio no existe para quien pregunta', async () => {
    const fixture = await createCatalogFixture(db);
    const theirs = await bookTurn(fixture, { customerId: await otherCustomerId(fixture) });

    const { content, options, isError } = await checkToMove(fixture, theirs);

    expect(isError).toBe(true);
    expect(content).toMatchObject({ motivo: 'turno_no_encontrado' });
    expect(options).toEqual([]);
    expect(content.libre).toBeUndefined();
    expect(content.horario).toBeUndefined();
  });

  it('el turno de otro negocio tampoco', async () => {
    const fixture = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    const foreign = await bookTurn(other);

    const { content, isError } = await checkToMove(fixture, foreign);

    expect(isError).toBe(true);
    expect(content).toMatchObject({ motivo: 'turno_no_encontrado' });
  });

  it('un turno que no existe es un error que el modelo puede corregir', async () => {
    const fixture = await createCatalogFixture(db);

    const { content, isError } = await checkToMove(fixture, '00000000-0000-4000-8000-000000000999');

    expect(isError).toBe(true);
    expect(content).toMatchObject({ motivo: 'turno_no_encontrado' });
    expect(JSON.stringify(content)).toContain('listar_turnos_de_la_clienta');
  });

  it('un turno cancelado ya no ocupa horario: no se reprograma', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);
    const changed = await changeAppointmentStatus(db, {
      tenantId: fixture.tenantId,
      appointmentId,
      to: 'CANCELLED_BY_CUSTOMER',
      actor: 'assistant',
      now: SUNDAY_MORNING,
    });
    expect(changed.ok).toBe(true);

    const { content, options, isError } = await checkToMove(fixture, appointmentId);

    expect(isError).toBe(true);
    expect(content).toMatchObject({ motivo: 'turno_no_activo' });
    expect(options).toEqual([]);
  });
});

describe('consultar_hora_para_reprogramar: entradas inválidas', () => {
  it.each([
    ['un turno_id que no es de un turno', { turno_id: 'el del martes' }, 'listar_turnos_de_la_clienta'],
    ['una hora sin cero adelante', { hora: '4:30' }, 'hora'],
    ['una hora que no existe', { hora: '24:30' }, 'hora'],
    ['una fecha con otro formato', { fecha: '7/10' }, 'fecha'],
  ])('%s no llega a la base: es un error que el modelo puede corregir', async (_description, input, mentioned) => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const { content, options, isError } = await checkToMove(fixture, appointmentId, input);

    expect(isError).toBe(true);
    expect(options).toEqual([]);
    expect(content.error).toBe('Entrada inválida');
    expect(JSON.stringify(content.detalles)).toContain(mentioned);
  });

  it('sin turno_id no hay qué consultar', async () => {
    const fixture = await createCatalogFixture(db);

    const result = await runTool(
      checkRescheduleTimeTool,
      { fecha: '2026-10-07', hora: '16:30' },
      toolContext(db, fixture),
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('turno_id');
  });
});
