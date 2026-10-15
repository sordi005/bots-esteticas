import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { services } from '../../src/modules/catalog/schema.js';
import { loadAvailabilityContext, loadRescheduleContext } from '../../src/modules/scheduling/availability-context.js';
import { bookAppointment, checkSlot } from '../../src/modules/scheduling/booking.js';
import { findCustomerAppointment } from '../../src/modules/scheduling/customer-appointments.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Domingo 4/10/2026 a las 9:00: el lunes 5 es el primer día con lugar.
const NOW = at('2026-10-04', '09:00');
const MINUTE_MS = 60_000;

async function book(f: CatalogFixture, input: { professionalId?: string; serviceId?: string; start: Date }) {
  const booked = await bookAppointment(db, {
    tenantId: f.tenantId,
    customerId: f.customerId,
    serviceId: input.serviceId ?? f.semi,
    professionalId: input.professionalId ?? f.mica,
    start: input.start,
    actor: 'assistant',
    now: NOW,
  });
  if (!booked.ok) throw new Error(booked.reason);
  const appointment = await findCustomerAppointment(db, {
    tenantId: f.tenantId,
    customerId: f.customerId,
    appointmentId: booked.appointmentId,
  });
  if (!appointment) throw new Error('No se encontró el turno recién creado');
  return appointment;
}

const windowAround = (start: Date) => ({ start, end: new Date(start.getTime() + MINUTE_MS) });

describe('loadRescheduleContext: el contexto de disponibilidad para mover un turno (4.6)', () => {
  it('guarda el margen del turno además de su duración', async () => {
    const f = await createCatalogFixture(db);

    const appointment = await book(f, { start: at('2026-10-05', '09:00') });

    expect(appointment).toMatchObject({ durationMinutes: 60, bufferMinutes: 10 });
  });

  it('el propio turno no cuenta como ocupado: se puede correr unos minutos sin chocar con uno mismo', async () => {
    const f = await createCatalogFixture(db);
    const appointment = await book(f, { start: at('2026-10-05', '09:00') });
    const nudged = at('2026-10-05', '09:30');

    const plain = await loadAvailabilityContext(db, {
      tenantId: f.tenantId,
      serviceId: f.semi,
      professionalIds: [f.mica],
      window: windowAround(nudged),
      now: NOW,
    });
    const rescheduling = await loadRescheduleContext(db, {
      tenantId: f.tenantId,
      appointment,
      window: windowAround(nudged),
      now: NOW,
    });

    const plainMica = plain?.query.professionals.find((p) => p.id === f.mica);
    const movingMica = rescheduling?.query.professionals.find((p) => p.id === f.mica);
    if (!plain || !plainMica || !rescheduling || !movingMica) throw new Error('Sin contexto');
    expect(checkSlot(plain, plainMica, nudged)).toBe('slot_taken');
    expect(checkSlot(rescheduling, movingMica, nudged)).toBe('ok');
  });

  it('los demás turnos de la profesional siguen ocupando el horario', async () => {
    const f = await createCatalogFixture(db);
    const appointment = await book(f, { start: at('2026-10-05', '09:00') });
    await book(f, { start: at('2026-10-05', '11:00') });
    const overlapping = at('2026-10-05', '10:30');

    const context = await loadRescheduleContext(db, {
      tenantId: f.tenantId,
      appointment,
      window: windowAround(overlapping),
      now: NOW,
    });

    const mica = context?.query.professionals.find((p) => p.id === f.mica);
    if (!context || !mica) throw new Error('Sin contexto');
    expect(checkSlot(context, mica, overlapping)).toBe('slot_taken');
  });

  it('usa la duración y el margen guardados en el turno, no los actuales del servicio', async () => {
    const f = await createCatalogFixture(db);
    const appointment = await book(f, { start: at('2026-10-05', '09:00') });
    await db.update(services).set({ durationMinutes: 30, bufferMinutes: 0 }).where(eq(services.id, f.semi));

    const context = await loadRescheduleContext(db, {
      tenantId: f.tenantId,
      appointment,
      window: windowAround(at('2026-10-06', '09:00')),
      now: NOW,
    });

    expect(context?.query.service).toEqual({ durationMinutes: 60, bufferMinutes: 10 });
  });

  it('es solo la profesional del turno, sin su duración propia del servicio (ya está en el turno)', async () => {
    const f = await createCatalogFixture(db);
    // Sofi hace el semi en 75 minutos; Mica también lo hace, pero este turno es de Sofi.
    const appointment = await book(f, { professionalId: f.sofi, start: at('2026-10-06', '10:00') });

    const context = await loadRescheduleContext(db, {
      tenantId: f.tenantId,
      appointment,
      window: windowAround(at('2026-10-07', '10:00')),
      now: NOW,
    });

    expect(appointment.durationMinutes).toBe(75);
    expect(context?.query.professionals.map((p) => ({ id: p.id, override: p.durationOverrideMinutes }))).toEqual([
      { id: f.sofi, override: null },
    ]);
    expect(context?.query.service.durationMinutes).toBe(75);
  });

  it('no mira turnos de otro negocio', async () => {
    const f = await createCatalogFixture(db);
    const other = await createCatalogFixture(db);
    const appointment = await book(f, { start: at('2026-10-05', '09:00') });

    const context = await loadRescheduleContext(db, {
      tenantId: other.tenantId,
      appointment,
      window: windowAround(at('2026-10-05', '09:00')),
      now: NOW,
    });

    // El servicio del turno no existe en el otro negocio.
    expect(context).toBeNull();
  });
});
