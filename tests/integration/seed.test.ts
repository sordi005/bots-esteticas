import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  businessInfo,
  professionals,
  professionalServices,
  services,
  workingHours,
} from '../../src/modules/catalog/schema.js';
import { tenants, tenantSettings } from '../../src/modules/tenants/schema.js';
import {
  DEMO_TENANT_ID,
  DEMO_TENANT_SLUG,
  seedEsteticaEjemplo,
} from '../../src/seeds/estetica-ejemplo.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

async function demoCounts() {
  const byTenant = async (
    table: typeof professionals | typeof services | typeof businessInfo | typeof workingHours,
  ) => single(await db.select({ total: count() }).from(table).where(eq(table.tenantId, DEMO_TENANT_ID))).total;

  return {
    tenants: single(await db.select({ total: count() }).from(tenants).where(eq(tenants.slug, DEMO_TENANT_SLUG))).total,
    settings: single(
      await db.select({ total: count() }).from(tenantSettings).where(eq(tenantSettings.tenantId, DEMO_TENANT_ID)),
    ).total,
    professionals: await byTenant(professionals),
    services: await byTenant(services),
    businessInfo: await byTenant(businessInfo),
    workingHours: await byTenant(workingHours),
    professionalServices: single(
      await db
        .select({ total: count() })
        .from(professionalServices)
        .where(eq(professionalServices.tenantId, DEMO_TENANT_ID)),
    ).total,
  };
}

const EXPECTED_COUNTS = {
  tenants: 1,
  settings: 1,
  professionals: 2,
  services: 8,
  businessInfo: 6,
  workingHours: 16,
  professionalServices: 10,
};

beforeAll(async () => {
  await seedEsteticaEjemplo(db);
});

afterAll(() => database.close());

describe('seed de Estética Ejemplo', () => {
  it('carga un negocio completo: configuración, equipo, catálogo, horarios e información', async () => {
    expect(await demoCounts()).toEqual(EXPECTED_COUNTS);
  });

  it('se puede correr varias veces sin duplicar nada', async () => {
    await seedEsteticaEjemplo(db);
    await seedEsteticaEjemplo(db);

    expect(await demoCounts()).toEqual(EXPECTED_COUNTS);
  });

  it('vuelve a dejar los datos del ejemplo si alguien los cambió', async () => {
    const semipermanente = single(
      await db
        .select({ id: services.id, priceCents: services.priceCents })
        .from(services)
        .where(and(eq(services.tenantId, DEMO_TENANT_ID), eq(services.name, 'Esmaltado semipermanente'))),
    );
    await db.update(services).set({ priceCents: 1 }).where(eq(services.id, semipermanente.id));

    await seedEsteticaEjemplo(db);

    const restored = single(
      await db.select({ priceCents: services.priceCents }).from(services).where(eq(services.id, semipermanente.id)),
    );
    expect(restored.priceCents).toBe(semipermanente.priceCents);
    expect(restored.priceCents).toBe(1_800_000);
  });

  it('todo servicio visible lo hace al menos una profesional activa', async () => {
    const result = await db.execute<{ name: string }>(sql`
      select s.name from ${services} s
      where s.tenant_id = ${DEMO_TENANT_ID} and s.visible
        and not exists (
          select 1 from ${professionalServices} ps
          join ${professionals} p on p.id = ps.professional_id and p.active
          where ps.service_id = s.id
        )
    `);

    expect(result.rows.map((row) => row.name)).toEqual([]);
  });

  it('toda profesional activa tiene horario cargado', async () => {
    const result = await db.execute<{ name: string }>(sql`
      select p.name from ${professionals} p
      where p.tenant_id = ${DEMO_TENANT_ID} and p.active
        and not exists (select 1 from ${workingHours} wh where wh.professional_id = p.id)
    `);

    expect(result.rows.map((row) => row.name)).toEqual([]);
  });
});
