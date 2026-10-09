import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { HANDOFF_PAUSE_MS, handOff, SENSITIVE_TOPIC_SUMMARY } from '../../src/modules/conversation/handoff.js';
import { conversations, handoffs } from '../../src/modules/conversation/schema.js';
import { tenants, tenantSettings, type AttentionHoursBlock } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

const WEEKDAYS: AttentionHoursBlock[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' }));

/** Hora de Mendoza (UTC-3) como instante. 2026-10-09 es viernes y el lunes 12/10 es feriado nacional. */
const mendoza = (date: string, time: string) => new Date(`${date}T${time}:00-03:00`);

async function tenantWithHours(blocks: AttentionHoursBlock[], worksOnHolidays = false) {
  const fixture = await createTenantFixture(db);
  await db
    .update(tenantSettings)
    .set({ humanAttentionHours: blocks, worksOnHolidays })
    .where(eq(tenantSettings.tenantId, fixture.tenantId));
  return fixture;
}

const handoffsOf = (tenantId: string, conversationId: string) =>
  db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.tenantId, tenantId), eq(handoffs.conversationId, conversationId)));

const conversationOf = async (tenantId: string, conversationId: string) =>
  single(
    await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId))),
  );

describe('handOff: derivar a una persona (4.8)', () => {
  it('registra la derivación abierta y pausa el asistente 12 horas, juntas', async () => {
    const f = await tenantWithHours(WEEKDAYS);
    const now = mendoza('2026-10-09', '10:00');

    await handOff(db, {
      tenantId: f.tenantId,
      conversationId: f.conversationId,
      reason: 'complaint',
      summary: 'Se quejó del turno de ayer',
      now,
    });

    expect(HANDOFF_PAUSE_MS).toBe(12 * 60 * 60 * 1_000);
    expect(await handoffsOf(f.tenantId, f.conversationId)).toEqual([
      expect.objectContaining({ reason: 'complaint', summary: 'Se quejó del turno de ayer', status: 'open', resolvedAt: null }),
    ]);
    expect(await conversationOf(f.tenantId, f.conversationId)).toMatchObject({
      assistantStatus: 'paused',
      pausedUntil: new Date(now.getTime() + HANDOFF_PAUSE_MS),
    });
  });

  it('con un tema sensible guarda el resumen fijo y descarta el del modelo (regla 9)', async () => {
    const f = await tenantWithHours(WEEKDAYS);

    await handOff(db, {
      tenantId: f.tenantId,
      conversationId: f.conversationId,
      reason: 'sensitive_topic',
      summary: 'Está embarazada de 3 meses',
      now: mendoza('2026-10-09', '10:00'),
    });

    expect(SENSITIVE_TOPIC_SUMMARY).toBe('Tema sensible: ver la conversación');
    const [handoff] = await handoffsOf(f.tenantId, f.conversationId);
    expect(handoff).toMatchObject({ reason: 'sensitive_topic', summary: SENSITIVE_TOPIC_SUMMARY });
  });

  it('recorta el resumen a 200 caracteres', async () => {
    const f = await tenantWithHours(WEEKDAYS);

    await handOff(db, {
      tenantId: f.tenantId,
      conversationId: f.conversationId,
      reason: 'off_catalog',
      summary: 'x'.repeat(300),
      now: mendoza('2026-10-09', '10:00'),
    });

    const [handoff] = await handoffsOf(f.tenantId, f.conversationId);
    expect(handoff?.summary).toHaveLength(200);
  });

  describe('cuándo le responde una persona (lee el horario y los feriados del negocio)', () => {
    it('dentro del horario: "en este horario"', async () => {
      const f = await tenantWithHours(WEEKDAYS);

      const result = await handOff(db, {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reason: 'customer_request',
        summary: 'Quiere hablar con una persona',
        now: mendoza('2026-10-09', '10:00'),
      });

      expect(result.when).toBe('en este horario');
    });

    it('fuera del horario: el próximo inicio, saltando el feriado si el negocio no trabaja feriados', async () => {
      const f = await tenantWithHours(WEEKDAYS);

      const result = await handOff(db, {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reason: 'customer_request',
        summary: 'Quiere hablar con una persona',
        now: mendoza('2026-10-09', '19:00'),
      });

      expect(result.when).toBe('el martes 13/10 a las 9:00');
    });

    it('si el negocio trabaja feriados, el lunes 12/10 cuenta', async () => {
      const f = await tenantWithHours(WEEKDAYS, true);

      const result = await handOff(db, {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reason: 'customer_request',
        summary: 'Quiere hablar con una persona',
        now: mendoza('2026-10-09', '19:00'),
      });

      expect(result.when).toBe('el lunes 12/10 a las 9:00');
    });

    it('sin horario cargado: "lo antes posible"', async () => {
      const f = await tenantWithHours([]);

      const result = await handOff(db, {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reason: 'customer_request',
        summary: 'Quiere hablar con una persona',
        now: mendoza('2026-10-09', '10:00'),
      });

      expect(result.when).toBe('lo antes posible');
    });

    it('usa la zona horaria del negocio', async () => {
      const f = await tenantWithHours(WEEKDAYS);
      await db.update(tenants).set({ timezone: 'America/Bogota' }).where(eq(tenants.id, f.tenantId));

      // Viernes 18:30 en Bogotá (UTC-5) = 20:30 en Mendoza: cerrado, y el lunes 12/10 es feriado.
      const result = await handOff(db, {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reason: 'customer_request',
        summary: 'Quiere hablar con una persona',
        now: new Date('2026-10-09T23:30:00Z'),
      });

      expect(result.when).toBe('el martes 13/10 a las 9:00');
    });
  });

  describe('aislamiento entre negocios (regla 1)', () => {
    it('con la conversación de otro negocio, falla sin registrar nada ni pausar esa conversación', async () => {
      const mine = await tenantWithHours(WEEKDAYS);
      const other = await tenantWithHours(WEEKDAYS);

      await expect(
        handOff(db, {
          tenantId: mine.tenantId,
          conversationId: other.conversationId,
          reason: 'complaint',
          summary: 'No debería guardarse',
          now: mendoza('2026-10-09', '10:00'),
        }),
      ).rejects.toThrow();

      expect(await handoffsOf(mine.tenantId, other.conversationId)).toEqual([]);
      expect(await handoffsOf(other.tenantId, other.conversationId)).toEqual([]);
      expect(await conversationOf(other.tenantId, other.conversationId)).toMatchObject({
        assistantStatus: 'active',
        pausedUntil: null,
      });
    });
  });
});
