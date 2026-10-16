import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../../shared/db.js';
import { professionals, services } from '../catalog/schema.js';
import { customers } from '../customers/schema.js';
import { appointments } from '../scheduling/schema.js';
import { tenants } from '../tenants/schema.js';
import type { NoticeAppointment, NoticeCustomer } from './texts.js';

/**
 * Los datos que muestran los avisos, leídos dentro de la transacción del cambio (6.7). Siempre
 * filtrados por el negocio (regla 1).
 */

/** Cómo se nombra a la clienta: el nombre del turno, o el de su perfil, o su teléfono. */
const customerName = (row: { name: string | null; profileName: string | null; phone: string }) =>
  row.name ?? row.profileName ?? row.phone;

export async function loadNoticeCustomer(
  db: Queryable,
  input: { tenantId: string; customerId: string },
): Promise<NoticeCustomer> {
  const [row] = await db
    .select({
      name: customers.name,
      profileName: customers.whatsappProfileName,
      phone: customers.phone,
      timeZone: tenants.timezone,
    })
    .from(customers)
    .innerJoin(tenants, eq(tenants.id, customers.tenantId))
    .where(and(eq(customers.tenantId, input.tenantId), eq(customers.id, input.customerId)));
  if (!row) throw new Error('No se encontró la clienta del aviso');
  return { customerName: customerName(row), customerPhone: row.phone, timeZone: row.timeZone };
}

export async function loadNoticeAppointment(
  db: Queryable,
  input: { tenantId: string; appointmentId: string },
): Promise<NoticeAppointment & { customerId: string }> {
  const [row] = await db
    .select({
      customerId: appointments.customerId,
      name: customers.name,
      profileName: customers.whatsappProfileName,
      phone: customers.phone,
      timeZone: tenants.timezone,
      serviceName: services.name,
      professionalName: professionals.name,
      timeRange: appointments.timeRange,
    })
    .from(appointments)
    .innerJoin(
      customers,
      and(eq(customers.tenantId, appointments.tenantId), eq(customers.id, appointments.customerId)),
    )
    .innerJoin(services, and(eq(services.tenantId, appointments.tenantId), eq(services.id, appointments.serviceId)))
    .innerJoin(
      professionals,
      and(eq(professionals.tenantId, appointments.tenantId), eq(professionals.id, appointments.professionalId)),
    )
    .innerJoin(tenants, eq(tenants.id, appointments.tenantId))
    .where(and(eq(appointments.tenantId, input.tenantId), eq(appointments.id, input.appointmentId)));
  if (!row) throw new Error('No se encontró el turno del aviso');
  return {
    customerId: row.customerId,
    customerName: customerName(row),
    customerPhone: row.phone,
    timeZone: row.timeZone,
    serviceName: row.serviceName,
    professionalName: row.professionalName,
    start: row.timeRange.start,
  };
}
