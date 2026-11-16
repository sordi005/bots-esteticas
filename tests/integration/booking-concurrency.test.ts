import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bookAppointment,
  changeAppointmentStatus,
  rescheduleAppointment,
  submitTransferReceipt,
} from '../../src/modules/scheduling/booking.js';
import { createDatabase } from '../../src/shared/db.js';
import { localDateTimeToInstant } from '../../src/shared/time-zone.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, createCustomer, type BookableFixture } from './support/fixtures.js';
import { gate } from './support/gate.js';

/**
 * Reservas simultáneas (sección 6.6): toda transacción que guarda, mueve o cambia el estado de un turno
 * toma primero el lock de su profesional. Así la segunda reserva del mismo horario recibe la violación
 * de `appointments_no_overlap` y no un deadlock, que Postgres tarda un segundo en detectar.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// Octubre de 2026 en Mendoza: el 4 es domingo y el 5 lunes.
const at = (date: string, time: string) =>
  localDateTimeToInstant(date, time, 'America/Argentina/Mendoza');
const SUNDAY_MORNING = at('2026-10-04', '09:00');
const MONDAY_10 = at('2026-10-05', '10:00');
/** Postgres espera esto antes de buscar un deadlock (`deadlock_timeout`, 1 s por defecto). */
const DEADLOCK_TIMEOUT_MS = 1000;

function booking(fixture: BookableFixture, customerId = fixture.customerId) {
  return bookAppointment(db, {
    tenantId: fixture.tenantId,
    customerId,
    serviceId: fixture.serviceId,
    professionalId: fixture.professionalId,
    start: MONDAY_10,
    actor: 'assistant',
    now: SUNDAY_MORNING,
  });
}

async function bookedAppointment(fixture: BookableFixture) {
  const result = await booking(fixture);
  if (!result.ok || !result.deposit) throw new Error('El fixture tenía que reservar con seña');
  return { appointmentId: result.appointmentId, depositId: result.deposit.id };
}

/**
 * Toma el lock de la profesional en otra transacción, calculado acá y no con el código de producción:
 * es lo mismo que haría otra profesional cuya clave choca con la suya en el hash. Hasta `release`,
 * todo lo que pida ese lock espera.
 */
async function holdScheduleLock(fixture: BookableFixture) {
  const acquired = gate();
  const release = gate();
  const held = db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${fixture.tenantId} || ':' || ${fixture.professionalId}, 0))`,
    );
    acquired.open();
    await release.opened;
  });
  await acquired.opened;
  return {
    release: async () => {
      release.open();
      await held;
    },
  };
}

/** Lo que devuelve `operation` si termina mientras el lock está tomado, o `'waiting'`. */
async function whileLockIsHeld<T>(fixture: BookableFixture, operation: () => Promise<T>) {
  const lock = await holdScheduleLock(fixture);
  const running = operation();
  const early = await Promise.race([
    running.then(() => 'finished' as const),
    new Promise<'waiting'>((resolve) => setTimeout(() => { resolve('waiting'); }, 300)),
  ]);
  await lock.release();
  return { early, result: await running };
}

describe('reservas simultáneas del mismo horario (6.6)', () => {
  it('ocho a la vez, varias veces: gana una sola y ninguna espera a que Postgres detecte un deadlock', async () => {
    for (let round = 0; round < 5; round += 1) {
      const fixture = await createBookableFixture(db);
      const contenders = await Promise.all(
        Array.from({ length: 8 }, () => createCustomer(db, fixture.tenantId)),
      );

      const startedAt = performance.now();
      const results = await Promise.all(contenders.map((customerId) => booking(fixture, customerId)));
      const elapsedMs = performance.now() - startedAt;

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual(
        Array.from({ length: 7 }, () => ({ ok: false, reason: 'slot_taken' })),
      );
      expect(elapsedMs).toBeLessThan(DEADLOCK_TIMEOUT_MS);
    }
  }, 30_000);
});

describe('el lock de la profesional va primero en cada transacción que ocupa su horario', () => {
  it('una reserva espera el lock; si es de otra profesional que choca en el hash, solo espera de más', async () => {
    const fixture = await createBookableFixture(db);

    const { early, result } = await whileLockIsHeld(fixture, () => booking(fixture));

    expect(early).toBe('waiting');
    expect(result).toMatchObject({ ok: true });
  });

  it('una reprogramación espera el lock', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await bookedAppointment(fixture);

    const { early, result } = await whileLockIsHeld(fixture, () =>
      rescheduleAppointment(db, {
        tenantId: fixture.tenantId,
        appointmentId,
        newStart: at('2026-10-05', '12:00'),
        actor: 'assistant',
        now: SUNDAY_MORNING,
      }),
    );

    expect(early).toBe('waiting');
    expect(result).toEqual({ ok: true });
  });

  it('un cambio de estado espera el lock: la tupla nueva vuelve a chequear la restricción', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId } = await bookedAppointment(fixture);

    const { early, result } = await whileLockIsHeld(fixture, () =>
      changeAppointmentStatus(db, {
        tenantId: fixture.tenantId,
        appointmentId,
        to: 'CONFIRMED',
        actor: 'owner',
        now: SUNDAY_MORNING,
      }),
    );

    expect(early).toBe('waiting');
    expect(result).toEqual({ ok: true });
  });

  it('un cambio de estado que llega por la seña también espera el lock', async () => {
    const fixture = await createBookableFixture(db);
    const { appointmentId, depositId } = await bookedAppointment(fixture);

    const { early, result } = await whileLockIsHeld(fixture, () =>
      submitTransferReceipt(db, {
        tenantId: fixture.tenantId,
        depositId,
        mediaId: 'comprobante-1',
        now: SUNDAY_MORNING,
      }),
    );

    expect(early).toBe('waiting');
    expect(result).toEqual({ ok: true, appointmentId, alreadyRegistered: false });
  });
});
