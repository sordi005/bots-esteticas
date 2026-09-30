import { eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  businessInfo,
  professionals,
  professionalServices,
  services,
  workingHours,
} from '../modules/catalog/schema.js';
import { tenants, tenantSettings } from '../modules/tenants/schema.js';

/**
 * "Estética Ejemplo": el negocio ficticio de la demo (sección 13, fase 0).
 * Todos los datos son inventados. Los IDs son fijos para que la demo tenga
 * referencias estables, y el seed se puede correr las veces que haga falta:
 * vuelve a dejar el catálogo, el equipo y los horarios como están acá.
 */
export const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_TENANT_SLUG = 'estetica-ejemplo';

const MICA = '00000000-0000-4000-8000-000000000101';
const SOFI = '00000000-0000-4000-8000-000000000102';

const pesos = (amount: number) => amount * 100;
const serviceId = (n: number) => `00000000-0000-4000-8000-${String(200 + n).padStart(12, '0')}`;
const businessInfoId = (n: number) => `00000000-0000-4000-8000-${String(300 + n).padStart(12, '0')}`;

const TENANT = {
  id: DEMO_TENANT_ID,
  name: 'Estética Ejemplo',
  slug: DEMO_TENANT_SLUG,
  plan: 'appointments',
  assistantName: 'Luna',
  emojiUsage: 'low',
  usesVoseo: true,
} satisfies typeof tenants.$inferInsert;

const SETTINGS = {
  tenantId: DEMO_TENANT_ID,
  transferAlias: 'estetica.ejemplo',
  transferAccountHolder: 'Estética Ejemplo',
  humanAttentionHours: [
    ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '19:00' })),
    { weekday: 6, start: '09:00', end: '13:00' },
  ],
} satisfies typeof tenantSettings.$inferInsert;

const PROFESSIONALS = [
  { id: MICA, tenantId: DEMO_TENANT_ID, name: 'Mica' },
  { id: SOFI, tenantId: DEMO_TENANT_ID, name: 'Sofi' },
] satisfies (typeof professionals.$inferInsert)[];

interface DemoService {
  service: typeof services.$inferInsert & { id: string };
  /** Quién lo hace y, si le lleva otro tiempo, cuánto. */
  doneBy: { professionalId: string; durationOverrideMinutes?: number }[];
}

const SERVICES: DemoService[] = [
  {
    service: {
      id: serviceId(1),
      tenantId: DEMO_TENANT_ID,
      name: 'Esmaltado semipermanente',
      aliases: ['semi', 'semipermanente', 'esmaltado'],
      category: 'Manos',
      durationMinutes: 60,
      bufferMinutes: 10,
      priceCents: pesos(18_000),
      cashPriceCents: pesos(16_000),
      maintenanceIntervalDays: 21,
    },
    // Sofi tarda más: sirve para probar duraciones distintas por profesional (11.1).
    doneBy: [{ professionalId: MICA }, { professionalId: SOFI, durationOverrideMinutes: 75 }],
  },
  {
    service: {
      id: serviceId(2),
      tenantId: DEMO_TENANT_ID,
      name: 'Uñas esculpidas',
      aliases: ['esculpidas', 'acrílicas', 'kapping'],
      category: 'Manos',
      durationMinutes: 120,
      bufferMinutes: 15,
      priceCents: pesos(28_000),
      cashPriceCents: pesos(25_000),
      priceType: 'from',
      maintenanceIntervalDays: 21,
    },
    doneBy: [{ professionalId: MICA }],
  },
  {
    service: {
      id: serviceId(3),
      tenantId: DEMO_TENANT_ID,
      name: 'Retiro de semipermanente',
      aliases: ['retiro', 'sacar el semi'],
      category: 'Manos',
      durationMinutes: 20,
      bufferMinutes: 5,
      priceCents: pesos(5_000),
      cashPriceCents: pesos(4_500),
    },
    doneBy: [{ professionalId: MICA }, { professionalId: SOFI }],
  },
  {
    service: {
      id: serviceId(4),
      tenantId: DEMO_TENANT_ID,
      name: 'Semipermanente en pies',
      aliases: ['pies', 'semi en pies', 'pedicura'],
      category: 'Pies',
      durationMinutes: 60,
      bufferMinutes: 10,
      priceCents: pesos(17_000),
      cashPriceCents: pesos(15_000),
      maintenanceIntervalDays: 28,
    },
    doneBy: [{ professionalId: SOFI }],
  },
  {
    service: {
      id: serviceId(5),
      tenantId: DEMO_TENANT_ID,
      name: 'Manos y pies semipermanente',
      aliases: ['manos y pies', 'combo'],
      category: 'Combos',
      durationMinutes: 120,
      bufferMinutes: 10,
      priceCents: pesos(32_000),
      cashPriceCents: pesos(29_000),
    },
    doneBy: [{ professionalId: MICA }],
  },
  {
    service: {
      id: serviceId(6),
      tenantId: DEMO_TENANT_ID,
      name: 'Lifting de pestañas',
      aliases: ['lifting', 'pestañas'],
      category: 'Pestañas',
      durationMinutes: 60,
      bufferMinutes: 10,
      priceCents: pesos(22_000),
      cashPriceCents: pesos(20_000),
      maintenanceIntervalDays: 42,
    },
    doneBy: [{ professionalId: SOFI }],
  },
  {
    service: {
      id: serviceId(7),
      tenantId: DEMO_TENANT_ID,
      name: 'Perfilado de cejas',
      aliases: ['cejas', 'perfilado'],
      category: 'Cejas',
      durationMinutes: 30,
      bufferMinutes: 5,
      priceCents: pesos(9_000),
      cashPriceCents: pesos(8_000),
    },
    doneBy: [{ professionalId: SOFI }],
  },
  {
    service: {
      id: serviceId(8),
      tenantId: DEMO_TENANT_ID,
      name: 'Depilación láser',
      aliases: ['láser', 'depilación'],
      category: 'Depilación',
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: pesos(25_000),
      priceType: 'from',
      // El asistente no lo agenda directo: deriva para la consulta previa (4.1).
      requiresConsultation: true,
    },
    doneBy: [{ professionalId: SOFI }],
  },
];

const BUSINESS_INFO: { topic: (typeof businessInfo.$inferInsert)['topic']; content: string }[] = [
  {
    topic: 'address',
    content: 'Estamos en Calle Ejemplo 123, Ciudad de Mendoza. Tocá el timbre "Estética Ejemplo".',
  },
  {
    topic: 'parking',
    content: 'No tenemos cochera propia. Hay estacionamiento medido en la cuadra.',
  },
  {
    topic: 'payment_methods',
    content:
      'Aceptamos efectivo, transferencia, Mercado Pago y tarjetas de débito y crédito. ' +
      'Pagando en efectivo o con transferencia tenés precio especial.',
  },
  { topic: 'promotions', content: 'Los martes, 20 % de descuento en servicios de pies.' },
  {
    topic: 'policies',
    content:
      'Para confirmar el turno pedimos una seña del 30 %, que se descuenta del total. ' +
      'Podés cancelar o reprogramar sin cargo hasta 24 horas antes. ' +
      'Con menos anticipación, lo charlás directamente con nosotras.',
  },
  {
    topic: 'aftercare',
    content:
      'Semipermanente: evitá el agua muy caliente las primeras 2 horas. ' +
      'Lifting: no mojes las pestañas durante 24 horas.',
  },
];

/** Horario semanal: 1 = lunes … 7 = domingo. */
const WORKING_HOURS = [
  // Mica: lunes a viernes de 9 a 13 y de 15 a 20, sábados de 9 a 13 (horario partido).
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    { professionalId: MICA, weekday, startTime: '09:00', endTime: '13:00' },
    { professionalId: MICA, weekday, startTime: '15:00', endTime: '20:00' },
  ]),
  { professionalId: MICA, weekday: 6, startTime: '09:00', endTime: '13:00' },
  // Sofi: martes a sábado de 10 a 18 (horario corrido).
  ...[2, 3, 4, 5, 6].map((weekday) => ({
    professionalId: SOFI,
    weekday,
    startTime: '10:00',
    endTime: '18:00',
  })),
];

/** En un upsert, pisa todas las columnas con el valor nuevo salvo `keep` y `created_at`. */
function overwriteOnConflict(table: PgTable, keep: string[]): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (key === 'createdAt' || keep.includes(key)) continue;
    set[key] = sql.raw(`excluded."${column.name}"`);
  }
  return set;
}

export async function seedEsteticaEjemplo(db: NodePgDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(tenants)
      .values(TENANT)
      .onConflictDoUpdate({ target: tenants.id, set: overwriteOnConflict(tenants, ['id']) });

    await tx.insert(tenantSettings).values(SETTINGS).onConflictDoUpdate({
      target: tenantSettings.tenantId,
      set: overwriteOnConflict(tenantSettings, ['tenantId']),
    });

    await tx.insert(professionals).values(PROFESSIONALS).onConflictDoUpdate({
      target: professionals.id,
      set: overwriteOnConflict(professionals, ['id']),
    });

    await tx
      .insert(services)
      .values(SERVICES.map(({ service }) => service))
      .onConflictDoUpdate({ target: services.id, set: overwriteOnConflict(services, ['id']) });

    await tx
      .insert(businessInfo)
      .values(
        BUSINESS_INFO.map((info, index) => ({
          id: businessInfoId(index + 1),
          tenantId: DEMO_TENANT_ID,
          ...info,
        })),
      )
      .onConflictDoUpdate({ target: businessInfo.id, set: overwriteOnConflict(businessInfo, ['id']) });

    // Relaciones y horarios no tienen referencias entrantes: se reemplazan enteros.
    await tx.delete(professionalServices).where(eq(professionalServices.tenantId, DEMO_TENANT_ID));
    await tx.insert(professionalServices).values(
      SERVICES.flatMap(({ service, doneBy }) =>
        doneBy.map((assignment) => ({
          tenantId: DEMO_TENANT_ID,
          serviceId: service.id,
          ...assignment,
        })),
      ),
    );

    await tx.delete(workingHours).where(eq(workingHours.tenantId, DEMO_TENANT_ID));
    await tx
      .insert(workingHours)
      .values(WORKING_HOURS.map((block) => ({ tenantId: DEMO_TENANT_ID, ...block })));
  });
}
