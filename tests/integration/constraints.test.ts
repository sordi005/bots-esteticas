import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workingHours } from '../../src/modules/catalog/schema.js';
import { handoffs, messages } from '../../src/modules/conversation/schema.js';
import { customers } from '../../src/modules/customers/schema.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { appointmentEvents, appointments } from '../../src/modules/scheduling/schema.js';
import { tenantSettings } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import {
  createTenantFixture,
  FIXTURE_APPOINTMENT_RANGE,
  type TenantFixture,
} from './support/fixtures.js';
import {
  CHECK_VIOLATION,
  expectConstraintViolation,
  UNIQUE_VIOLATION,
} from './support/postgres-errors.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

let fixture: TenantFixture;

beforeAll(async () => {
  fixture = await createTenantFixture(db);
});

afterAll(() => database.close());

describe('reglas que protege la base', () => {
  it('el rango de un turno coincide con su duración más el margen', async () => {
    await expectConstraintViolation(
      db.insert(appointments).values({
        tenantId: fixture.tenantId,
        customerId: fixture.customerId,
        serviceId: fixture.serviceId,
        professionalId: fixture.professionalId,
        // 70 minutos de rango para 60 + 30 de servicio: no coincide.
        timeRange: FIXTURE_APPOINTMENT_RANGE,
        durationMinutes: 60,
        bufferMinutes: 30,
        priceCents: 1_800_000,
        priceType: 'fixed',
        status: 'PENDING_DEPOSIT',
        origin: 'assistant',
      }),
      CHECK_VIOLATION,
      'appointments_time_range_matches_duration',
    );
  });

  it.each([
    ['porcentaje y monto fijo a la vez', { depositPercentage: 30, depositFixedAmountCents: 500_000 }],
    ['ni porcentaje ni monto fijo', { depositPercentage: null, depositFixedAmountCents: null }],
  ])('la seña del negocio no puede tener %s', async (_case, amounts) => {
    await expectConstraintViolation(
      db.update(tenantSettings).set(amounts).where(eq(tenantSettings.tenantId, fixture.tenantId)),
      CHECK_VIOLATION,
      'tenant_settings_deposit_single_amount',
    );
  });

  it('el teléfono de la clienta está en formato internacional', async () => {
    await expectConstraintViolation(
      db.insert(customers).values({ tenantId: fixture.tenantId, phone: '261 400-0000' }),
      CHECK_VIOLATION,
      'customers_phone_e164',
    );
  });

  it('un bloque horario empieza antes de terminar', async () => {
    await expectConstraintViolation(
      db.insert(workingHours).values({
        tenantId: fixture.tenantId,
        professionalId: fixture.professionalId,
        weekday: 1,
        startTime: '13:00',
        endTime: '09:00',
      }),
      CHECK_VIOLATION,
      'working_hours_start_before_end',
    );
  });

  it('una seña en verificación tiene comprobante', async () => {
    await expectConstraintViolation(
      db.insert(deposits).values({
        tenantId: fixture.tenantId,
        appointmentId: fixture.appointmentId,
        amountCents: 540_000,
        status: 'in_review',
        expiresAt: FIXTURE_APPOINTMENT_RANGE.start,
      }),
      CHECK_VIOLATION,
      'deposits_review_has_receipt',
    );
  });

  it('una derivación resuelta tiene fecha de resolución', async () => {
    await expectConstraintViolation(
      db.insert(handoffs).values({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        reason: 'customer_request',
        summary: 'Pidió hablar con una persona',
        status: 'resolved',
      }),
      CHECK_VIOLATION,
      'handoffs_resolved_at_matches_status',
    );
  });

  it('un mensaje recibido trae el id de WhatsApp', async () => {
    await expectConstraintViolation(
      db.insert(messages).values({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        direction: 'inbound',
        type: 'text',
        content: { body: 'hola' },
        occurredAt: FIXTURE_APPOINTMENT_RANGE.start,
      }),
      CHECK_VIOLATION,
      'messages_received_have_whatsapp_id',
    );
  });

  it.each([
    ['un cambio de estado que no cambia el estado', { kind: 'status_change', fromStatus: 'CONFIRMED' }],
    ['una reprogramación sin el horario anterior', { kind: 'rescheduled', fromStatus: 'CONFIRMED' }],
    [
      'una reprogramación que cambia el estado',
      { kind: 'rescheduled', fromStatus: 'PENDING_DEPOSIT', previousTimeRange: FIXTURE_APPOINTMENT_RANGE },
    ],
  ] as const)('la auditoría rechaza %s', async (_case, event) => {
    await expectConstraintViolation(
      db.insert(appointmentEvents).values({
        tenantId: fixture.tenantId,
        appointmentId: fixture.appointmentId,
        toStatus: 'CONFIRMED',
        actor: 'owner',
        ...event,
      }),
      CHECK_VIOLATION,
      'appointment_events_kind_consistent',
    );
  });

  it('la auditoría guarda una reprogramación con el horario anterior', async () => {
    await expect(
      db.insert(appointmentEvents).values({
        tenantId: fixture.tenantId,
        appointmentId: fixture.appointmentId,
        kind: 'rescheduled',
        fromStatus: 'CONFIRMED',
        toStatus: 'CONFIRMED',
        previousTimeRange: FIXTURE_APPOINTMENT_RANGE,
        actor: 'assistant',
      }),
    ).resolves.toBeDefined();
  });

  it('el mismo mensaje de WhatsApp se guarda una sola vez (idempotencia)', async () => {
    const message = {
      tenantId: fixture.tenantId,
      conversationId: fixture.conversationId,
      direction: 'inbound' as const,
      type: 'text',
      content: { body: 'hola' },
      whatsappMessageId: `wamid.${fixture.tenantId}`,
      occurredAt: FIXTURE_APPOINTMENT_RANGE.start,
    };
    await db.insert(messages).values(message);

    await expectConstraintViolation(
      db.insert(messages).values(message),
      UNIQUE_VIOLATION,
      'messages_whatsapp_message_id_unique',
    );
  });

  it('solo un mensaje entrante se marca como procesado', async () => {
    await expectConstraintViolation(
      db.insert(messages).values({
        tenantId: fixture.tenantId,
        conversationId: fixture.conversationId,
        direction: 'outbound',
        type: 'text',
        content: { body: 'hola' },
        occurredAt: FIXTURE_APPOINTMENT_RANGE.start,
        processedAt: FIXTURE_APPOINTMENT_RANGE.start,
      }),
      CHECK_VIOLATION,
      'messages_processed_only_inbound',
    );
  });

  describe('tareas programadas (sección 6.7)', () => {
    const job = (overrides: Partial<typeof scheduledJobs.$inferInsert> = {}) => ({
      tenantId: fixture.tenantId,
      kind: 'process_conversation' as const,
      key: randomUUID(),
      runAt: FIXTURE_APPOINTMENT_RANGE.start,
      ...overrides,
    });

    it('la misma tarea con la misma clave se guarda una sola vez por negocio', async () => {
      const first = job();
      await db.insert(scheduledJobs).values(first);

      await expectConstraintViolation(
        db.insert(scheduledJobs).values(job({ key: first.key })),
        UNIQUE_VIOLATION,
        'scheduled_jobs_tenant_kind_key_key',
      );
    });

    it.each([
      ['en ejecución sin plazo ni token', { status: 'running' as const }],
      [
        'pendiente con plazo y token',
        { lockedUntil: FIXTURE_APPOINTMENT_RANGE.end, lockToken: randomUUID() },
      ],
    ])('una tarea no puede estar %s', async (_case, overrides) => {
      await expectConstraintViolation(
        db.insert(scheduledJobs).values(job(overrides)),
        CHECK_VIOLATION,
        'scheduled_jobs_lock_matches_status',
      );
    });

    it('solo una tarea en ejecución anota que hay que volver a ejecutarla', async () => {
      await expectConstraintViolation(
        db.insert(scheduledJobs).values(job({ rerunAt: FIXTURE_APPOINTMENT_RANGE.end })),
        CHECK_VIOLATION,
        'scheduled_jobs_rerun_only_while_running',
      );
    });

    it('los intentos no son negativos', async () => {
      await expectConstraintViolation(
        db.insert(scheduledJobs).values(job({ attempts: -1 })),
        CHECK_VIOLATION,
        'scheduled_jobs_attempts_non_negative',
      );
    });
  });
});
