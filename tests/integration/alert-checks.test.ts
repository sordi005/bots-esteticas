import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ALERT_CHECK_INTERVAL_MS, alertChecksJobHandler, scheduleAlertChecks } from '../../src/modules/alerts/check-job.js';
import { conversations, handoffs, messages } from '../../src/modules/conversation/schema.js';
import type { ClaimedJob } from '../../src/modules/jobs/queue.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { tenants, tenantSettings, type AttentionHoursBlock } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { captureLogs } from '../support/log-capture.js';
import { testDatabaseUrl } from './support/database.js';
import { createCustomer, createTenantFixture, single, type TenantFixture } from './support/fixtures.js';

/**
 * La tarea "revisar alertas" (10.3): una por negocio, cada 15 minutos. Lee la base y levanta las
 * alertas de ecos, derivaciones, feriados y tasa semanal.
 */
const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

// La cola es una sola para todos los negocios: cada test arranca sin tareas.
beforeEach(async () => {
  await db.delete(scheduledJobs);
});

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// Jueves 26/11/2026, 12:00 en Mendoza.
const THURSDAY_NOON = new Date('2026-11-26T15:00:00Z');

/** De lunes a sábado de 9 a 20. */
const OPEN_MON_TO_SAT: AttentionHoursBlock[] = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '20:00' }));

async function tenantWith(options: { coexistenceSince?: Date; attention?: AttentionHoursBlock[] } = {}) {
  const fixture = await createTenantFixture(db);
  await db
    .update(tenants)
    .set({ whatsappCoexistenceSince: options.coexistenceSince ?? null })
    .where(eq(tenants.id, fixture.tenantId));
  await db
    .update(tenantSettings)
    .set({ humanAttentionHours: options.attention ?? OPEN_MON_TO_SAT })
    .where(eq(tenantSettings.tenantId, fixture.tenantId));
  return fixture;
}

function claimed(tenantId: string): ClaimedJob {
  return { id: randomUUID(), tenantId, kind: 'check_alerts', key: tenantId, payload: {}, attempts: 1, lockToken: randomUUID() };
}

async function check(fixture: Pick<TenantFixture, 'tenantId'>, now: Date) {
  const { logger, alerts } = captureLogs();
  await alertChecksJobHandler({ db, logger, now: () => now })(claimed(fixture.tenantId), {
    signal: new AbortController().signal,
    lastAttempt: false,
  });
  return alerts();
}

function message(fixture: Pick<TenantFixture, 'tenantId' | 'conversationId'>, direction: 'inbound' | 'echo', at: Date) {
  return db.insert(messages).values({
    tenantId: fixture.tenantId,
    conversationId: fixture.conversationId,
    direction,
    type: 'text',
    content: { body: 'hola' },
    whatsappMessageId: `wamid.${randomUUID()}`,
    occurredAt: at,
    createdAt: at,
  });
}

function handoff(fixture: Pick<TenantFixture, 'tenantId' | 'conversationId'>, createdAt: Date, status: 'open' | 'resolved' = 'open') {
  return db.insert(handoffs).values({
    tenantId: fixture.tenantId,
    conversationId: fixture.conversationId,
    reason: 'customer_request',
    summary: 'Quiere hablar con alguien',
    status,
    resolvedAt: status === 'resolved' ? createdAt : null,
    createdAt,
  });
}

describe('alertChecksJobHandler', () => {
  it('al empezar programa la próxima vuelta, a los 15 minutos', async () => {
    const fixture = await tenantWith();

    await check(fixture, THURSDAY_NOON);

    const next = single(
      await db
        .select()
        .from(scheduledJobs)
        .where(and(eq(scheduledJobs.tenantId, fixture.tenantId), eq(scheduledJobs.kind, 'check_alerts'))),
    );
    expect(ALERT_CHECK_INTERVAL_MS).toBe(15 * 60_000);
    expect(next).toMatchObject({ key: fixture.tenantId, runAt: new Date(THURSDAY_NOON.getTime() + ALERT_CHECK_INTERVAL_MS) });
  });

  it('un negocio que ya no está activo no se revisa ni se reprograma (regla 7)', async () => {
    const fixture = await tenantWith({ coexistenceSince: new Date(THURSDAY_NOON.getTime() - 30 * DAY_MS) });
    await db.update(tenants).set({ status: 'paused' }).where(eq(tenants.id, fixture.tenantId));

    expect(await check(fixture, THURSDAY_NOON)).toEqual([]);
    expect(await db.select().from(scheduledJobs).where(eq(scheduledJobs.tenantId, fixture.tenantId))).toEqual([]);
  });

  describe('ecos', () => {
    it('en coexistencia y sin ecos hace más de 10 días, alerta', async () => {
      const fixture = await tenantWith({ coexistenceSince: new Date(THURSDAY_NOON.getTime() - 30 * DAY_MS) });
      await message(fixture, 'echo', new Date(THURSDAY_NOON.getTime() - 11 * DAY_MS));

      expect(await check(fixture, THURSDAY_NOON)).toEqual([
        expect.objectContaining({ alert: 'echoes_missing', tenantId: fixture.tenantId, daysWithoutEchoes: 11 }),
      ]);
    });

    it('con un eco reciente no alerta; los mensajes de las clientas no cuentan como ecos', async () => {
      const fixture = await tenantWith({ coexistenceSince: new Date(THURSDAY_NOON.getTime() - 30 * DAY_MS) });
      await message(fixture, 'echo', new Date(THURSDAY_NOON.getTime() - 2 * DAY_MS));
      expect(await check(fixture, THURSDAY_NOON)).toEqual([]);

      const other = await tenantWith({ coexistenceSince: new Date(THURSDAY_NOON.getTime() - 30 * DAY_MS) });
      await message(other, 'inbound', new Date(THURSDAY_NOON.getTime() - DAY_MS));
      expect(await check(other, THURSDAY_NOON)).toEqual([expect.objectContaining({ alert: 'echoes_missing' })]);
    });
  });

  describe('derivaciones', () => {
    it('abierta hace más de 4 horas con el negocio atendiendo, alerta; resuelta, no', async () => {
      const fixture = await tenantWith();
      await handoff(fixture, new Date(THURSDAY_NOON.getTime() - 5 * HOUR_MS), 'resolved');
      expect(await check(fixture, THURSDAY_NOON)).toEqual([]);

      await handoff(fixture, new Date(THURSDAY_NOON.getTime() - 5 * HOUR_MS));
      expect(await check(fixture, THURSDAY_NOON)).toEqual([
        expect.objectContaining({ alert: 'handoff_waiting', tenantId: fixture.tenantId, openHandoffs: 1 }),
      ]);
    });

    it('una abierta el viernes a las 19:50 avisa el sábado al abrir, no a la noche', async () => {
      const fixture = await tenantWith();
      await handoff(fixture, new Date('2026-11-27T22:50:00Z')); // viernes 19:50 en Mendoza

      expect(await check(fixture, new Date('2026-11-28T03:00:00Z'))).toEqual([]); // sábado 00:00
      expect(await check(fixture, new Date('2026-11-28T12:00:00Z'))).toEqual([
        expect.objectContaining({ alert: 'handoff_waiting' }),
      ]); // sábado 9:00
    });
  });

  it('desde el 1 de diciembre, sin feriados del año siguiente, alerta para todos los negocios', async () => {
    const fixture = await tenantWith();

    // 2027 ya tiene los inamovibles (migración 0023); 2031 todavía no tiene ninguno.
    expect(await check(fixture, new Date('2026-12-01T15:00:00Z'))).toEqual([]);
    expect(await check(fixture, new Date('2030-12-02T15:00:00Z'))).toEqual([
      expect.objectContaining({ alert: 'holidays_missing', tenantId: null, detail: '2031' }),
    ]);
  });

  it('los lunes alerta si las derivaciones de la semana pasan el 30 % de las conversaciones', async () => {
    const fixture = await tenantWith();
    const monday = new Date('2026-11-30T12:00:00Z'); // lunes 9:00 en Mendoza
    const customerId = await createCustomer(db, fixture.tenantId);
    const { id: secondConversation } = single(
      await db.insert(conversations).values({ tenantId: fixture.tenantId, customerId }).returning({ id: conversations.id }),
    );
    await message(fixture, 'inbound', new Date(monday.getTime() - 2 * DAY_MS));
    await message({ ...fixture, conversationId: secondConversation }, 'inbound', new Date(monday.getTime() - 3 * DAY_MS));
    // Fuera de la semana: no cuenta.
    await handoff(fixture, new Date(monday.getTime() - 9 * DAY_MS), 'resolved');
    await handoff(fixture, new Date(monday.getTime() - DAY_MS), 'resolved');

    expect(await check(fixture, monday)).toEqual([
      expect.objectContaining({
        alert: 'handoff_rate',
        tenantId: fixture.tenantId,
        detail: 'semana-2026-11-30',
        weeklyHandoffs: 1,
        weeklyConversations: 2,
      }),
    ]);
  });
});

describe('scheduleAlertChecks: al arrancar, una revisión por negocio activo', () => {
  it('programa la de cada negocio activo para ahora, y no la de uno pausado', async () => {
    const active = await tenantWith();
    const paused = await tenantWith();
    await db.update(tenants).set({ status: 'paused' }).where(eq(tenants.id, paused.tenantId));

    await scheduleAlertChecks(db, THURSDAY_NOON);
    await scheduleAlertChecks(db, THURSDAY_NOON);

    const jobs = await db.select().from(scheduledJobs).where(eq(scheduledJobs.kind, 'check_alerts'));
    expect(jobs.filter((job) => job.tenantId === active.tenantId)).toEqual([
      expect.objectContaining({ key: active.tenantId, runAt: THURSDAY_NOON, status: 'pending' }),
    ]);
    expect(jobs.filter((job) => job.tenantId === paused.tenantId)).toEqual([]);
  });
});
