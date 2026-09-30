import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { professionals } from '../../src/modules/catalog/schema.js';
import {
  APPOINTMENT_STATUSES,
  occupiesSchedule,
  type AppointmentStatus,
} from '../../src/modules/scheduling/appointment-state-machine.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { findPostgresError } from '../../src/shared/postgres-errors.js';
import type { TimestampRange } from '../../src/shared/timestamp-range.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single, type TenantFixture } from './support/fixtures.js';
import { EXCLUSION_VIOLATION, expectConstraintViolation } from './support/postgres-errors.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

let fixture: TenantFixture;

beforeAll(async () => {
  fixture = await createTenantFixture(db);
});

afterAll(() => database.close());

/** 60 minutos de servicio más 10 de margen, el día `day` de noviembre, a las `hour` UTC. */
function slot(day: number, hour: number): TimestampRange {
  const start = new Date(Date.UTC(2026, 10, day, hour));
  return { start, end: new Date(start.getTime() + 70 * 60_000) };
}

function appointmentValues(
  timeRange: TimestampRange,
  status: AppointmentStatus = 'CONFIRMED',
  professionalId = fixture.professionalId,
) {
  return {
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    serviceId: fixture.serviceId,
    professionalId,
    timeRange,
    durationMinutes: 60,
    bufferMinutes: 10,
    priceCents: 1_800_000,
    priceType: 'fixed' as const,
    status,
    origin: 'assistant' as const,
  };
}

describe('dos turnos no se superponen (sección 6.6)', () => {
  it('la base rechaza un turno que pisa otro de la misma profesional', async () => {
    await db.insert(appointments).values(appointmentValues(slot(2, 13)));

    await expectConstraintViolation(
      db.insert(appointments).values(appointmentValues(slot(2, 14))),
      EXCLUSION_VIOLATION,
      'appointments_no_overlap',
    );
  });

  it('dos turnos pegados no se superponen: el rango es [inicio, fin)', async () => {
    const first = slot(3, 13);
    await db.insert(appointments).values(appointmentValues(first));

    const next = { start: first.end, end: new Date(first.end.getTime() + 70 * 60_000) };
    await expect(db.insert(appointments).values(appointmentValues(next))).resolves.toBeDefined();
  });

  it('otra profesional puede atender a la misma hora', async () => {
    const { id: otherProfessionalId } = single(
      await db
        .insert(professionals)
        .values({ tenantId: fixture.tenantId, name: 'Sofi' })
        .returning({ id: professionals.id }),
    );
    await db.insert(appointments).values(appointmentValues(slot(4, 13)));

    await expect(
      db.insert(appointments).values(appointmentValues(slot(4, 13), 'CONFIRMED', otherProfessionalId)),
    ).resolves.toBeDefined();
  });

  it.each(APPOINTMENT_STATUSES.map((status, index) => [status, index] as const))(
    'un turno %s bloquea el horario solo si la máquina de estados dice que lo ocupa',
    async (status, index) => {
      const range = slot(10 + index, 13);
      await db.insert(appointments).values(appointmentValues(range, status));

      const overlapping = db.insert(appointments).values(appointmentValues(range));

      if (occupiesSchedule(status)) {
        await expectConstraintViolation(overlapping, EXCLUSION_VIOLATION, 'appointments_no_overlap');
      } else {
        await expect(overlapping).resolves.toBeDefined();
      }
    },
  );

  it('con dos transacciones al mismo tiempo, gana una sola', async () => {
    const range = slot(25, 13);
    const book = () =>
      db.transaction(async (tx) => {
        await tx.insert(appointments).values(appointmentValues(range));
        // La primera en insertar retiene su lugar un rato: la otra queda esperando.
        await tx.execute(sql`select pg_sleep(0.2)`);
      });

    const results = await Promise.allSettled([book(), book()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter((result) => result.status === 'rejected');
    expect(findPostgresError(rejected?.reason)).toEqual({
      code: EXCLUSION_VIOLATION,
      constraint: 'appointments_no_overlap',
    });
  });
});
