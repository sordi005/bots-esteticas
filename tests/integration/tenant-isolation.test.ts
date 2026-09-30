import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  professionalServices,
  scheduleExceptions,
  workingHours,
} from '../../src/modules/catalog/schema.js';
import { conversations, handoffs, messages } from '../../src/modules/conversation/schema.js';
import { customers } from '../../src/modules/customers/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import {
  createTenantFixture,
  FIXTURE_APPOINTMENT_RANGE,
  FIXTURE_CUSTOMER_PHONE,
  type TenantFixture,
} from './support/fixtures.js';
import { expectConstraintViolation, FOREIGN_KEY_VIOLATION } from './support/postgres-errors.js';

/** Las únicas tablas sin `tenant_id`: el negocio en sí y los feriados nacionales. */
const GLOBAL_TABLES = ['holidays', 'tenants'];

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

describe('aislamiento entre negocios: estructura', () => {
  it('toda tabla de negocio tiene tenant_id obligatorio que apunta a tenants', async () => {
    const result = await db.execute<{ table_name: string; problem: string | null }>(sql`
      select t.table_name,
        case
          when c.column_name is null then 'sin tenant_id'
          when c.is_nullable = 'YES' then 'tenant_id acepta null'
          when not exists (
            select 1 from pg_constraint fk
            where fk.contype = 'f'
              and fk.conrelid = format('public.%I', t.table_name)::regclass
              and fk.confrelid = 'public.tenants'::regclass
          ) then 'tenant_id no referencia a tenants'
        end as problem
      from information_schema.tables t
      left join information_schema.columns c
        on c.table_schema = t.table_schema and c.table_name = t.table_name
        and c.column_name = 'tenant_id'
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
    `);

    const problems = result.rows
      .filter((row) => !GLOBAL_TABLES.includes(row.table_name) && row.problem !== null)
      .map((row) => `${row.table_name}: ${row.problem ?? ''}`);

    expect(problems).toEqual([]);
  });

  it('toda relación entre tablas de negocio incluye tenant_id en la clave foránea', async () => {
    const result = await db.execute<{
      constraint_name: string;
      columns: string[];
      referenced_columns: string[];
    }>(sql`
      select fk.conname as constraint_name,
        array(
          select a.attname from unnest(fk.conkey) with ordinality as k(attnum, position)
          join pg_attribute a on a.attrelid = fk.conrelid and a.attnum = k.attnum
          order by k.position
        )::text[] as columns,
        array(
          select a.attname from unnest(fk.confkey) with ordinality as k(attnum, position)
          join pg_attribute a on a.attrelid = fk.confrelid and a.attnum = k.attnum
          order by k.position
        )::text[] as referenced_columns
      from pg_constraint fk
      where fk.contype = 'f'
        and fk.connamespace = 'public'::regnamespace
        and fk.confrelid <> 'public.tenants'::regclass
    `);

    expect(result.rows.length).toBeGreaterThan(0);

    const withoutTenant = result.rows
      .filter(
        (row) =>
          !row.columns.includes('tenant_id') ||
          row.columns.indexOf('tenant_id') !== row.referenced_columns.indexOf('tenant_id'),
      )
      .map((row) => row.constraint_name);

    expect(withoutTenant).toEqual([]);
  });
});

describe('aislamiento entre negocios: la base rechaza mezclar datos', () => {
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    a = await createTenantFixture(db);
    b = await createTenantFixture(db);
  });

  it('la misma persona en dos negocios son dos clientas distintas', async () => {
    const rows = await db
      .select({ id: customers.id, tenantId: customers.tenantId })
      .from(customers)
      .where(
        and(
          eq(customers.phone, FIXTURE_CUSTOMER_PHONE),
          inArray(customers.tenantId, [a.tenantId, b.tenantId]),
        ),
      );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
  });

  it('un servicio de otro negocio no se asigna a una profesional', async () => {
    await expectConstraintViolation(
      db
        .insert(professionalServices)
        .values({ tenantId: a.tenantId, professionalId: a.professionalId, serviceId: b.serviceId }),
      FOREIGN_KEY_VIOLATION,
      'professional_services_service_fk',
    );
  });

  it('una clienta no prefiere a una profesional de otro negocio', async () => {
    await expectConstraintViolation(
      db.insert(customers).values({
        tenantId: a.tenantId,
        phone: '+5492614000999',
        preferredProfessionalId: b.professionalId,
      }),
      FOREIGN_KEY_VIOLATION,
      'customers_preferred_professional_fk',
    );
  });

  it('el horario semanal no se carga a una profesional de otro negocio', async () => {
    await expectConstraintViolation(
      db.insert(workingHours).values({
        tenantId: a.tenantId,
        professionalId: b.professionalId,
        weekday: 1,
        startTime: '09:00',
        endTime: '13:00',
      }),
      FOREIGN_KEY_VIOLATION,
      'working_hours_professional_fk',
    );
  });

  it('una excepción de horario no se carga a una profesional de otro negocio', async () => {
    await expectConstraintViolation(
      db.insert(scheduleExceptions).values({
        tenantId: a.tenantId,
        professionalId: b.professionalId,
        timeRange: FIXTURE_APPOINTMENT_RANGE,
        kind: 'closed',
      }),
      FOREIGN_KEY_VIOLATION,
      'schedule_exceptions_professional_fk',
    );
  });

  it.each([
    ['la clienta', 'customerId', 'appointments_customer_fk'],
    ['el servicio', 'serviceId', 'appointments_service_fk'],
    ['la profesional', 'professionalId', 'appointments_professional_fk'],
  ] as const)('un turno no usa %s de otro negocio', async (_what, field, constraint) => {
    // Un horario libre: así la única regla que puede fallar es la de aislamiento.
    const freeRange = {
      start: new Date('2026-12-01T13:00:00.000Z'),
      end: new Date('2026-12-01T14:10:00.000Z'),
    };
    await expectConstraintViolation(
      db.insert(appointments).values({
        tenantId: a.tenantId,
        customerId: a.customerId,
        serviceId: a.serviceId,
        professionalId: a.professionalId,
        [field]: b[field],
        timeRange: freeRange,
        durationMinutes: 60,
        bufferMinutes: 10,
        priceCents: 1_800_000,
        priceType: 'fixed',
        status: 'CONFIRMED',
        origin: 'assistant',
      }),
      FOREIGN_KEY_VIOLATION,
      constraint,
    );
  });

  it('un evento de auditoría no se registra sobre un turno de otro negocio', async () => {
    await expectConstraintViolation(
      db.insert(appointmentEvents).values({
        tenantId: a.tenantId,
        appointmentId: b.appointmentId,
        toStatus: 'CANCELLED_BY_BUSINESS',
        actor: 'owner',
      }),
      FOREIGN_KEY_VIOLATION,
      'appointment_events_appointment_fk',
    );
  });

  it('una seña no se asocia a un turno de otro negocio', async () => {
    await expectConstraintViolation(
      db.insert(deposits).values({
        tenantId: a.tenantId,
        appointmentId: b.appointmentId,
        amountCents: 540_000,
        expiresAt: FIXTURE_APPOINTMENT_RANGE.start,
      }),
      FOREIGN_KEY_VIOLATION,
      'deposits_appointment_fk',
    );
  });

  it('una conversación no se abre con una clienta de otro negocio', async () => {
    await expectConstraintViolation(
      db.insert(conversations).values({ tenantId: a.tenantId, customerId: b.customerId }),
      FOREIGN_KEY_VIOLATION,
      'conversations_customer_fk',
    );
  });

  it('un mensaje no se guarda en una conversación de otro negocio', async () => {
    await expectConstraintViolation(
      db.insert(messages).values({
        tenantId: a.tenantId,
        conversationId: b.conversationId,
        direction: 'outbound',
        type: 'text',
        content: { body: 'hola' },
        occurredAt: FIXTURE_APPOINTMENT_RANGE.start,
      }),
      FOREIGN_KEY_VIOLATION,
      'messages_conversation_fk',
    );
  });

  it('una derivación no se crea sobre una conversación de otro negocio', async () => {
    await expectConstraintViolation(
      db.insert(handoffs).values({
        tenantId: a.tenantId,
        conversationId: b.conversationId,
        reason: 'complaint',
        summary: 'Reclamo por un servicio',
      }),
      FOREIGN_KEY_VIOLATION,
      'handoffs_conversation_fk',
    );
  });
});
