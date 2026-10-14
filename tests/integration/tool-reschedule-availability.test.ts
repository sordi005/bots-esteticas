import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { services } from '../../src/modules/catalog/schema.js';
import { checkAvailabilityTool } from '../../src/modules/conversation/tools/check-availability.js';
import { checkRescheduleAvailabilityTool } from '../../src/modules/conversation/tools/check-reschedule-availability.js';
import { parseChoiceId } from '../../src/modules/conversation/tools/choice-ids.js';
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
  proximoHorario?: Entry;
  motivo?: string;
  [key: string]: unknown;
}

const texts = (availability: Availability) =>
  availability.horarios.map((entry) => `${entry.texto} con ${entry.profesional}`);

describe('consultar_horarios_para_reprogramar: horarios para mover un turno (4.6, decisión 28)', () => {
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

  /** Reserva un turno de la clienta (por defecto, semi con Mica el martes 6/10 a las 10:00). */
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
    const result = await runTool(
      checkRescheduleAvailabilityTool,
      { turno_id: turnoId, desde: '2026-10-06', hasta: '2026-10-06', ...input },
      toolContext(db, fixture, overrides),
    );
    return { ...result, content: result.content as Availability };
  }

  it('devuelve horarios con ids reprogramar:<turno>:<inicio>, el turno que se mueve y el servicio del turno', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const { content, options, isError } = await checkToMove(fixture, appointmentId);

    expect(isError).toBeUndefined();
    expect(content.servicio).toEqual({ id: fixture.semi, nombre: 'Esmaltado semipermanente' });
    expect(content.turno).toEqual({ turnoId: `turno:${appointmentId}`, actual: 'martes 6/10 10:00' });
    expect(content.horarios[0]).toMatchObject({
      // 9:00 en Mendoza (UTC-3) es 12:00 UTC.
      opcionId: `reprogramar:${appointmentId}:2026-10-06T12:00:00.000Z`,
      texto: 'martes 6/10 9:00',
      profesional: 'Mica',
      profesionalId: fixture.mica,
    });
    expect(options[0]).toEqual({
      id: `reprogramar:${appointmentId}:2026-10-06T12:00:00.000Z`,
      title: 'mar 6/10 9:00',
      description: 'con Mica',
    });
    for (const option of options.slice(0, -1)) {
      expect(parseChoiceId(option.id)).toMatchObject({ kind: 'reschedule', appointmentId });
    }
    expectOptionsShownToModel({ content, options });
  });

  it('acepta el turno con el prefijo turno: o el uuid solo', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const withPrefix = await checkToMove(fixture, `turno:${appointmentId}`);
    const bare = await checkToMove(fixture, appointmentId);

    expect(withPrefix.isError).toBeUndefined();
    expect(texts(withPrefix.content)).toEqual(texts(bare.content));
  });

  it('el servicio y la profesional son los del turno: sin servicio_id, y solo horarios de esa profesional', async () => {
    const fixture = await createCatalogFixture(db);
    // Sofi hace el semi en 75 minutos y Mica también lo hace: el turno es de Sofi.
    const appointmentId = await bookTurn(fixture, { professionalId: fixture.sofi, start: at('2026-10-06', '11:00') });

    const { content } = await checkToMove(fixture, appointmentId, { desde: '2026-10-07', hasta: '2026-10-07' });

    expect(content.horarios.length).toBeGreaterThan(0);
    expect(new Set(content.horarios.map((entry) => entry.profesional))).toEqual(new Set(['Sofi']));
    expect(new Set(content.horarios.map((entry) => entry.duracionMinutos))).toEqual(new Set([75]));
  });

  it('el propio turno no ocupa lugar: ofrece horarios que pisarían su hora actual', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const { content } = await checkToMove(fixture, appointmentId);

    // Sin descontar el turno, las 9:00 (hasta las 10:10) chocarían con el suyo (10:00 a 11:10).
    expect(texts(content)).toEqual(['martes 6/10 9:00 con Mica', 'martes 6/10 10:30 con Mica', 'martes 6/10 12:00 con Mica']);
  });

  it('no ofrece el horario en el que el turno ya está', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    // Después de las 9:45: lo primero libre sería las 10:00, justo donde está el turno.
    const { content } = await checkToMove(fixture, appointmentId, { despues_de: '2026-10-06T12:45:00.000Z' });

    expect(content.horarios.map((entry) => entry.inicio)).not.toContain('2026-10-06T13:00:00.000Z');
    expect(content.horarios[0]?.texto).toBe('martes 6/10 10:15');
  });

  it('los demás turnos de la profesional sí ocupan', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);
    // De otra clienta, de 11:15 a 12:25: el de la clienta (10:00 a 11:10) no lo pisa.
    await bookTurn(fixture, { customerId: await otherCustomerId(fixture), start: at('2026-10-06', '11:15') });

    const { content } = await checkToMove(fixture, appointmentId);

    // Libres: las 9:00 (por quedar libre el lugar del propio turno) y la tarde. Las 10:30 pisarían al otro turno.
    expect(texts(content)).toContain('martes 6/10 9:00 con Mica');
    expect(texts(content)).not.toContain('martes 6/10 10:30 con Mica');
    expect(texts(content)).toContain('martes 6/10 15:00 con Mica');
  });

  it('usa la duración y el margen que tiene el turno, no los actuales del servicio', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);
    await db.update(services).set({ durationMinutes: 30, bufferMinutes: 0 }).where(eq(services.id, fixture.semi));

    const { content } = await checkToMove(fixture, appointmentId);

    expect(new Set(content.horarios.map((entry) => entry.duracionMinutos))).toEqual(new Set([60]));
  });

  it('un servicio que después dejó de ofrecerse igual se puede reprogramar: el turno ya existe', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);
    await db.update(services).set({ visible: false }).where(eq(services.id, fixture.semi));

    const { content, isError } = await checkToMove(fixture, appointmentId);

    expect(isError).toBeUndefined();
    expect(content.horarios.length).toBeGreaterThan(0);
  });

  it('"Ver otros horarios" sigue en modo reprogramación: lleva el turno y el último horario ofrecido', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    const first = await checkToMove(fixture, appointmentId);

    // 12:00 en Mendoza es 15:00 UTC.
    expect(first.options.at(-1)).toEqual({
      id: `mas_reprogramar:${appointmentId}:2026-10-06T15:00:00.000Z`,
      title: 'Ver otros horarios',
    });
    expectOptionsShownToModel(first);
    expect(first.content).toMatchObject({
      verMas: { opcionId: `mas_reprogramar:${appointmentId}:2026-10-06T15:00:00.000Z`, texto: 'Ver otros horarios' },
    });

    const next = await checkToMove(fixture, appointmentId, { despues_de: '2026-10-06T15:00:00.000Z' });
    expect(next.content.horarios.length).toBeGreaterThan(0);
    for (const entry of next.content.horarios) {
      expect(entry.opcionId.startsWith(`reprogramar:${appointmentId}:`)).toBe(true);
      expect(new Date(entry.inicio).getTime()).toBeGreaterThan(new Date('2026-10-06T15:00:00.000Z').getTime());
    }
  });

  it('sin lugar en el rango, el próximo horario libre también se ofrece para reprogramar', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);

    // Domingo 11: cerrado. El lunes 12 es feriado: lo próximo es el martes 13 a las 9:00.
    const { content, options } = await checkToMove(fixture, appointmentId, { desde: '2026-10-11', hasta: '2026-10-11' });

    expect(content.horarios).toEqual([]);
    expect(content.proximoHorario).toMatchObject({
      opcionId: `reprogramar:${appointmentId}:2026-10-13T12:00:00.000Z`,
      texto: 'martes 13/10 9:00',
    });
    expect(options).toEqual([
      { id: `reprogramar:${appointmentId}:2026-10-13T12:00:00.000Z`, title: 'mar 13/10 9:00', description: 'con Mica' },
    ]);
  });

  describe('solo el turno de la clienta que escribe, y que todavía ocupa horario', () => {
    it('el turno de otra clienta del mismo negocio no existe para quien pregunta', async () => {
      const fixture = await createCatalogFixture(db);
      const theirs = await bookTurn(fixture, { customerId: await otherCustomerId(fixture) });

      const { content, options, isError } = await checkToMove(fixture, theirs);

      expect(isError).toBe(true);
      expect(content).toMatchObject({ motivo: 'turno_no_encontrado' });
      expect(options).toEqual([]);
      expect(content.horarios).toBeUndefined();
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

  describe('el servicio y la profesional son siempre los del turno', () => {
    it('lo que mande el modelo de servicio o de profesional no cambia nada: la herramienta no los tiene', async () => {
      const fixture = await createCatalogFixture(db);
      const appointmentId = await bookTurn(fixture);

      const plain = await checkToMove(fixture, appointmentId);
      const withOthers = await checkToMove(fixture, appointmentId, {
        servicio_id: fixture.sculpted,
        profesional_id: fixture.sofi,
      });

      expect(withOthers.isError).toBeUndefined();
      expect(texts(withOthers.content)).toEqual(texts(plain.content));
      expect(new Set(withOthers.content.horarios.map((entry) => entry.profesional))).toEqual(new Set(['Mica']));
    });

    it('un turno_id que no es un id de turno no llega a la base: es una entrada inválida que el modelo puede corregir', async () => {
      const fixture = await createCatalogFixture(db);

      const { content, options, isError } = await checkToMove(fixture, 'el del martes');

      expect(isError).toBe(true);
      expect(options).toEqual([]);
      expect(JSON.stringify(content)).toContain('listar_turnos_de_la_clienta');
    });

    it('sin turno_id no hay qué consultar: es una entrada inválida', async () => {
      const fixture = await createCatalogFixture(db);

      const result = await runTool(
        checkRescheduleAvailabilityTool,
        { desde: '2026-10-06', hasta: '2026-10-06' },
        toolContext(db, fixture),
      );

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('turno_id');
    });
  });

  it('un servicio que ahora requiere consulta previa igual se puede reprogramar: el turno ya existe', async () => {
    const fixture = await createCatalogFixture(db);
    const appointmentId = await bookTurn(fixture);
    await db.update(services).set({ requiresConsultation: true }).where(eq(services.id, fixture.semi));

    const { content, isError } = await checkToMove(fixture, appointmentId);

    expect(isError).toBeUndefined();
    expect(content.horarios.length).toBeGreaterThan(0);
  });

  it('consultar_disponibilidad sigue siendo para reservar: ids horario:, no reprogramar:', async () => {
    const fixture = await createCatalogFixture(db);

    const { options } = await runTool(
      checkAvailabilityTool,
      { servicio_id: fixture.semi, desde: '2026-10-06', hasta: '2026-10-06' },
      toolContext(db, fixture),
    );

    expect(options[0]?.id.startsWith('horario:')).toBe(true);
  });
});
