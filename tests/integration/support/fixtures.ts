import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  professionals,
  professionalServices,
  services,
  workingHours,
} from '../../../src/modules/catalog/schema.js';
import { conversations } from '../../../src/modules/conversation/schema.js';
import { customers } from '../../../src/modules/customers/schema.js';
import { appointments } from '../../../src/modules/scheduling/schema.js';
import { tenants, tenantSettings } from '../../../src/modules/tenants/schema.js';

/** Un negocio completo con una fila de cada entidad principal, listo para probar relaciones. */
export interface TenantFixture {
  tenantId: string;
  professionalId: string;
  serviceId: string;
  customerId: string;
  appointmentId: string;
  conversationId: string;
}

export const FIXTURE_CUSTOMER_PHONE = '+5492614000001';

export const FIXTURE_APPOINTMENT_RANGE = {
  start: new Date('2026-10-05T13:00:00.000Z'),
  end: new Date('2026-10-05T14:10:00.000Z'),
};

export function single<T>(rows: T[]): T {
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`Se esperaba exactamente una fila y hubo ${String(rows.length)}`);
  }
  return row;
}

export async function createTenantFixture(db: NodePgDatabase): Promise<TenantFixture> {
  const label = randomUUID().slice(0, 8);

  const { id: tenantId } = single(
    await db
      .insert(tenants)
      .values({
        name: `Negocio ${label}`,
        slug: `negocio-${label}`,
        plan: 'appointments',
        assistantName: 'Luna',
      })
      .returning({ id: tenants.id }),
  );
  await db.insert(tenantSettings).values({ tenantId });

  const { id: professionalId } = single(
    await db
      .insert(professionals)
      .values({ tenantId, name: 'Mica' })
      .returning({ id: professionals.id }),
  );

  const { id: serviceId } = single(
    await db
      .insert(services)
      .values({
        tenantId,
        name: 'Esmaltado semipermanente',
        category: 'Manos',
        durationMinutes: 60,
        bufferMinutes: 10,
        priceCents: 1_800_000,
      })
      .returning({ id: services.id }),
  );
  await db.insert(professionalServices).values({ tenantId, professionalId, serviceId });

  const { id: customerId } = single(
    await db
      .insert(customers)
      .values({ tenantId, phone: FIXTURE_CUSTOMER_PHONE, name: 'Caro Pérez' })
      .returning({ id: customers.id }),
  );

  const { id: appointmentId } = single(
    await db
      .insert(appointments)
      .values({
        tenantId,
        customerId,
        serviceId,
        professionalId,
        timeRange: FIXTURE_APPOINTMENT_RANGE,
        durationMinutes: 60,
        bufferMinutes: 10,
        priceCents: 1_800_000,
        priceType: 'fixed',
        status: 'CONFIRMED',
        origin: 'assistant',
      })
      .returning({ id: appointments.id }),
  );

  const { id: conversationId } = single(
    await db
      .insert(conversations)
      .values({ tenantId, customerId })
      .returning({ id: conversations.id }),
  );

  return { tenantId, professionalId, serviceId, customerId, appointmentId, conversationId };
}

/** Un negocio listo para reservar: Mica hace semipermanente con horario partido. */
export interface BookableFixture {
  tenantId: string;
  professionalId: string;
  serviceId: string;
  customerId: string;
}

export async function createBookableFixture(
  db: NodePgDatabase,
  options: {
    settings?: Partial<typeof tenantSettings.$inferInsert>;
    service?: Partial<typeof services.$inferInsert>;
    durationOverrideMinutes?: number;
  } = {},
): Promise<BookableFixture> {
  const label = randomUUID().slice(0, 8);

  const { id: tenantId } = single(
    await db
      .insert(tenants)
      .values({ name: `Estética ${label}`, slug: `estetica-${label}`, plan: 'appointments', assistantName: 'Luna' })
      .returning({ id: tenants.id }),
  );
  await db.insert(tenantSettings).values({ tenantId, ...options.settings });

  const { id: professionalId } = single(
    await db.insert(professionals).values({ tenantId, name: 'Mica' }).returning({ id: professionals.id }),
  );
  // Lunes a viernes de 9 a 13 y de 15 a 20; sábados de 9 a 13 (hora del negocio).
  await db.insert(workingHours).values([
    ...[1, 2, 3, 4, 5].flatMap((weekday) => [
      { tenantId, professionalId, weekday, startTime: '09:00', endTime: '13:00' },
      { tenantId, professionalId, weekday, startTime: '15:00', endTime: '20:00' },
    ]),
    { tenantId, professionalId, weekday: 6, startTime: '09:00', endTime: '13:00' },
  ]);

  const { id: serviceId } = single(
    await db
      .insert(services)
      .values({
        tenantId,
        name: 'Esmaltado semipermanente',
        category: 'Manos',
        durationMinutes: 60,
        bufferMinutes: 10,
        priceCents: 1_800_000,
        cashPriceCents: 1_600_000,
        ...options.service,
      })
      .returning({ id: services.id }),
  );
  await db.insert(professionalServices).values({
    tenantId,
    professionalId,
    serviceId,
    durationOverrideMinutes: options.durationOverrideMinutes ?? null,
  });

  const { id: customerId } = single(
    await db
      .insert(customers)
      .values({ tenantId, phone: FIXTURE_CUSTOMER_PHONE, name: 'Caro Pérez' })
      .returning({ id: customers.id }),
  );

  return { tenantId, professionalId, serviceId, customerId };
}

/** Otra clienta del mismo negocio. */
export async function createCustomer(db: NodePgDatabase, tenantId: string): Promise<string> {
  const phone = `+54926140${String(Math.floor(Math.random() * 100_000)).padStart(5, '0')}`;
  const { id } = single(
    await db.insert(customers).values({ tenantId, phone }).returning({ id: customers.id }),
  );
  return id;
}
