import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { professionals, professionalServices, services } from '../../../src/modules/catalog/schema.js';
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
