import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { loadAvailabilityContext } from '../../src/modules/scheduling/availability-context.js';
import { bookAppointment, checkSlot } from '../../src/modules/scheduling/booking.js';
import { calendarBlocks } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { CHECK_VIOLATION, expectConstraintViolation } from './support/postgres-errors.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Domingo 4/10/2026 a las 9:00: el lunes 5 es el primer día con lugar.
const NOW = at('2026-10-04', '09:00');
const MINUTE_MS = 60_000;

const windowAround = (start: Date) => ({ start, end: new Date(start.getTime() + MINUTE_MS) });

async function block(f: CatalogFixture, professionalId: string, start: Date, end: Date, tenantId = f.tenantId) {
  await db.insert(calendarBlocks).values({ tenantId, professionalId, timeRange: { start, end } });
}

async function slotFor(f: CatalogFixture, professionalId: string, start: Date) {
  const context = await loadAvailabilityContext(db, {
    tenantId: f.tenantId,
    serviceId: f.semi,
    professionalIds: [professionalId],
    window: windowAround(start),
    now: NOW,
  });
  const professional = context?.query.professionals.find((p) => p.id === professionalId);
  if (!context || !professional) throw new Error('Sin contexto');
  return checkSlot(context, professional, start);
}

describe('calendar_blocks: los eventos ocupados de Google Calendar bloquean horarios (4.2, 8.4)', () => {
  it('un bloqueo de la profesional ocupa el horario', async () => {
    const f = await createCatalogFixture(db);
    await block(f, f.mica, at('2026-10-05', '10:00'), at('2026-10-05', '11:00'));

    expect(await slotFor(f, f.mica, at('2026-10-05', '10:00'))).toBe('slot_taken');
  });

  it('el turno tampoco puede terminar (con su margen) adentro de un bloqueo', async () => {
    const f = await createCatalogFixture(db);
    await block(f, f.mica, at('2026-10-05', '10:00'), at('2026-10-05', '11:00'));

    // Semipermanente: 60 minutos + 10 de margen. A las 9:00 el margen termina 10:10.
    expect(await slotFor(f, f.mica, at('2026-10-05', '09:00'))).toBe('slot_taken');
    expect(await slotFor(f, f.mica, at('2026-10-05', '11:00'))).toBe('ok');
  });

  it('el bloqueo de otra profesional no la afecta', async () => {
    const f = await createCatalogFixture(db);
    await block(f, f.sofi, at('2026-10-05', '10:00'), at('2026-10-05', '11:00'));

    expect(await slotFor(f, f.mica, at('2026-10-05', '10:00'))).toBe('ok');
  });

  it('el bloqueo de otro negocio no se mezcla', async () => {
    const f = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    await block(other, other.mica, at('2026-10-05', '10:00'), at('2026-10-05', '11:00'));

    expect(await slotFor(f, f.mica, at('2026-10-05', '10:00'))).toBe('ok');
  });

  it('una reserva sobre un bloqueo se rechaza', async () => {
    const f = await createCatalogFixture(db);
    await block(f, f.mica, at('2026-10-05', '10:00'), at('2026-10-05', '11:00'));

    const booked = await bookAppointment(db, {
      tenantId: f.tenantId,
      customerId: f.customerId,
      serviceId: f.semi,
      professionalId: f.mica,
      start: at('2026-10-05', '10:00'),
      actor: 'assistant',
      now: NOW,
    });

    expect(booked).toMatchObject({ ok: false, reason: 'slot_taken' });
  });

  it('la base rechaza un bloqueo vacío', async () => {
    const f = await createCatalogFixture(db);

    // El código ya no arma un rango vacío: se escribe directo para probar la base.
    await expectConstraintViolation(
      db.execute(sql`
        insert into calendar_blocks (tenant_id, professional_id, time_range)
        values (${f.tenantId}, ${f.mica}, 'empty')`),
      CHECK_VIOLATION,
      'calendar_blocks_time_range_valid',
    );
  });
});
