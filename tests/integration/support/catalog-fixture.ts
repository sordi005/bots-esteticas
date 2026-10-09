import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  professionals,
  professionalServices,
  services,
  workingHours,
} from '../../../src/modules/catalog/schema.js';
import { customers } from '../../../src/modules/customers/schema.js';
import type { ToolContext } from '../../../src/modules/conversation/tools/tool.js';
import { tenants, tenantSettings } from '../../../src/modules/tenants/schema.js';
import { localDateTimeToInstant } from '../../../src/shared/time-zone.js';
import { single } from './fixtures.js';

export const MENDOZA = 'America/Argentina/Mendoza';

/** Un instante a partir de una fecha y hora locales de Mendoza. */
export const at = (date: string, time: string) => localDateTimeToInstant(date, time, MENDOZA);

const pesos = (amount: number) => amount * 100;

/**
 * Un negocio con el catálogo y los horarios de "Estética Ejemplo", pero con ids al azar:
 * cada test tiene el suyo y no depende del orden. Mica hace casi todo; Sofi hace el
 * semipermanente en 75 minutos.
 */
export interface CatalogFixture {
  tenantId: string;
  customerId: string;
  mica: string;
  sofi: string;
  semi: string;
  sculpted: string;
  feetSemi: string;
  laser: string;
  hidden: string;
}

export async function createCatalogFixture(
  db: NodePgDatabase,
  options: { settings?: Partial<typeof tenantSettings.$inferInsert> } = {},
): Promise<CatalogFixture> {
  const label = randomUUID().slice(0, 8);
  const { id: tenantId } = single(
    await db
      .insert(tenants)
      .values({ name: `Estética ${label}`, slug: `estetica-${label}`, plan: 'appointments', assistantName: 'Luna' })
      .returning({ id: tenants.id }),
  );
  await db.insert(tenantSettings).values({ tenantId, ...options.settings });

  const [mica, sofi] = (
    await db
      .insert(professionals)
      .values([
        { tenantId, name: 'Mica' },
        { tenantId, name: 'Sofi' },
      ])
      .returning({ id: professionals.id })
  ).map((row) => row.id);
  if (!mica || !sofi) throw new Error('No se crearon las profesionales');

  const service = async (values: Partial<typeof services.$inferInsert> & { name: string }) =>
    single(
      await db
        .insert(services)
        .values({ tenantId, category: 'Manos', durationMinutes: 60, bufferMinutes: 10, priceCents: 0, ...values })
        .returning({ id: services.id }),
    ).id;

  const semi = await service({
    name: 'Esmaltado semipermanente',
    aliases: ['semi', 'semipermanente', 'esmaltado'],
    priceCents: pesos(18_000),
    cashPriceCents: pesos(16_000),
  });
  const sculpted = await service({
    name: 'Uñas esculpidas',
    aliases: ['esculpidas', 'acrílicas', 'kapping'],
    durationMinutes: 120,
    bufferMinutes: 15,
    priceCents: pesos(28_000),
    cashPriceCents: pesos(25_000),
    priceType: 'from',
  });
  const feetSemi = await service({
    name: 'Semipermanente en pies',
    aliases: ['pies', 'semi en pies', 'pedicura'],
    category: 'Pies',
    priceCents: pesos(17_000),
    cashPriceCents: pesos(15_000),
  });
  const laser = await service({
    name: 'Depilación láser',
    aliases: ['láser', 'depilación'],
    category: 'Depilación',
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: pesos(25_000),
    priceType: 'from',
    requiresConsultation: true,
  });
  const hidden = await service({ name: 'Servicio que no se ofrece', priceCents: pesos(1_000), visible: false });

  await db.insert(professionalServices).values([
    { tenantId, serviceId: semi, professionalId: mica },
    { tenantId, serviceId: semi, professionalId: sofi, durationOverrideMinutes: 75 },
    { tenantId, serviceId: sculpted, professionalId: mica },
    { tenantId, serviceId: feetSemi, professionalId: sofi },
    { tenantId, serviceId: laser, professionalId: sofi },
    { tenantId, serviceId: hidden, professionalId: mica },
  ]);

  // Mica: lunes a viernes de 9 a 13 y de 15 a 20, sábados de 9 a 13. Sofi: martes a sábado de 10 a 18.
  await db.insert(workingHours).values([
    ...[1, 2, 3, 4, 5].flatMap((weekday) => [
      { tenantId, professionalId: mica, weekday, startTime: '09:00', endTime: '13:00' },
      { tenantId, professionalId: mica, weekday, startTime: '15:00', endTime: '20:00' },
    ]),
    { tenantId, professionalId: mica, weekday: 6, startTime: '09:00', endTime: '13:00' },
    ...[2, 3, 4, 5, 6].map((weekday) => ({
      tenantId,
      professionalId: sofi,
      weekday,
      startTime: '10:00',
      endTime: '18:00',
    })),
  ]);

  const { id: customerId } = single(
    await db
      .insert(customers)
      .values({ tenantId, phone: `+54926140${String(Math.floor(Math.random() * 100_000)).padStart(5, '0')}` })
      .returning({ id: customers.id }),
  );

  return { tenantId, customerId, mica, sofi, semi, sculpted, feetSemi, laser, hidden };
}

/**
 * El contexto que arma el servidor para una vuelta del agente. Por defecto "ahora" es el
 * domingo 4/10/2026 a las 9:00 en Mendoza: el lunes 5 es el primer día con lugar.
 */
export function toolContext(
  db: NodePgDatabase,
  fixture: Pick<CatalogFixture, 'tenantId' | 'customerId'>,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    db,
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    now: at('2026-10-04', '09:00'),
    timeZone: MENDOZA,
    signal: new AbortController().signal,
    ...overrides,
  };
}
