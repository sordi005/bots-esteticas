import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { HANDOFF_PAUSE_MS, handOff, SENSITIVE_TOPIC_SUMMARY } from '../../src/modules/conversation/handoff.js';
import { conversations, handoffs } from '../../src/modules/conversation/schema.js';
import { notifications } from '../../src/modules/notifications/schema.js';
import { tenants, tenantSettings, type AttentionHoursBlock } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { noticeBody } from './support/notices.js';
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

  describe('sin derivaciones repetidas', () => {
    const derive = (f: { tenantId: string; conversationId: string }, now: Date, reason: 'policy_exception' | 'complaint' = 'policy_exception') =>
      handOff(db, { tenantId: f.tenantId, conversationId: f.conversationId, reason, summary: 'Pide cancelar fuera de plazo', now });

    it('si la conversación ya está pausada, devuelve la derivación abierta en vez de crear otra', async () => {
      const f = await tenantWithHours(WEEKDAYS);
      const first = await derive(f, mendoza('2026-10-09', '10:00'));

      // Más tarde, en la misma pausa: por ejemplo, cancelar fuera de plazo y después derivar.
      const second = await derive(f, mendoza('2026-10-09', '10:05'), 'complaint');

      expect(second).toEqual(first);
      expect(await handoffsOf(f.tenantId, f.conversationId)).toHaveLength(1);
    });

    it('no corre la pausa: sigue venciendo 12 horas después de la primera derivación', async () => {
      const f = await tenantWithHours(WEEKDAYS);
      const firstAt = mendoza('2026-10-09', '10:00');
      await derive(f, firstAt);

      await derive(f, mendoza('2026-10-09', '11:00'));

      expect((await conversationOf(f.tenantId, f.conversationId)).pausedUntil).toEqual(
        new Date(firstAt.getTime() + HANDOFF_PAUSE_MS),
      );
    });

    it('dos derivaciones a la vez dejan una sola fila (se bloquea la conversación)', async () => {
      const f = await tenantWithHours(WEEKDAYS);
      const now = mendoza('2026-10-09', '10:00');

      const [a, b] = await Promise.all([derive(f, now), derive(f, now)]);

      expect(a.handoffId).toBe(b.handoffId);
      expect(await handoffsOf(f.tenantId, f.conversationId)).toHaveLength(1);
    });

    it('con la pausa vencida, una derivación nueva sí se registra y vuelve a pausar', async () => {
      const f = await tenantWithHours(WEEKDAYS);
      const firstAt = mendoza('2026-10-09', '10:00');
      const first = await derive(f, firstAt);

      const later = new Date(firstAt.getTime() + HANDOFF_PAUSE_MS + 60_000);
      const second = await derive(f, later);

      expect(second.handoffId).not.toBe(first.handoffId);
      expect(await handoffsOf(f.tenantId, f.conversationId)).toHaveLength(2);
      expect((await conversationOf(f.tenantId, f.conversationId)).pausedUntil).toEqual(
        new Date(later.getTime() + HANDOFF_PAUSE_MS),
      );
    });

    it('una pausa sin derivación abierta (por ejemplo, la dueña escribió) no impide registrar una', async () => {
      const f = await tenantWithHours(WEEKDAYS);
      const now = mendoza('2026-10-09', '10:00');
      await db
        .update(conversations)
        .set({ assistantStatus: 'paused', pausedUntil: new Date(now.getTime() + HANDOFF_PAUSE_MS) })
        .where(eq(conversations.id, f.conversationId));

      await derive(f, now);

      expect(await handoffsOf(f.tenantId, f.conversationId)).toHaveLength(1);
    });
  });

  describe('el aviso a la dueña (4.8, H9)', () => {
    const noticesOf = (tenantId: string) =>
      db.select().from(notifications).where(eq(notifications.tenantId, tenantId));

    it('se guarda junto con la derivación, con el botón «Ya la atendí»', async () => {
      const f = await tenantWithHours(WEEKDAYS);

      const { handoffId } = await handOff(db, {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reason: 'complaint',
        summary: 'Se quejó del turno de ayer',
        now: mendoza('2026-10-09', '10:00'),
      });

      const [notice] = await noticesOf(f.tenantId);
      expect(notice).toMatchObject({
        recipient: 'owner',
        kind: 'handoff',
        handoffId,
        customerId: f.customerId,
        status: 'pending',
        message: {
          type: 'buttons',
          buttons: [{ id: `aviso:${notice?.id ?? ''}:atendida`, title: 'Ya la atendí' }],
        },
      });
      expect(noticeBody(notice?.message)).toContain('Caro Pérez');
      expect(noticeBody(notice?.message)).toContain('Se quejó del turno de ayer');
      // Pausado hasta las 22:00 del mismo viernes (12 horas).
      expect(noticeBody(notice?.message)).toContain('viernes 9/10 22:00');
      expect(notice?.template).toMatchObject({
        name: 'aviso_derivacion',
        params: { resumen: 'Se quejó del turno de ayer', hasta: 'viernes 9/10 22:00' },
      });
    });

    it('con un tema sensible, el aviso lleva el resumen fijo y nunca el detalle (regla 9)', async () => {
      const f = await tenantWithHours(WEEKDAYS);

      await handOff(db, {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reason: 'sensitive_topic',
        summary: 'Está embarazada de tres meses',
        now: mendoza('2026-10-09', '10:00'),
      });

      const [notice] = await noticesOf(f.tenantId);
      expect(noticeBody(notice?.message)).toContain(SENSITIVE_TOPIC_SUMMARY);
      expect(noticeBody(notice?.message)).not.toMatch(/embarazada/);
      // La plantilla tampoco lleva el detalle de salud (regla 9).
      expect(notice?.template?.params.resumen).toBe(SENSITIVE_TOPIC_SUMMARY);
    });

    it('una derivación repetida en la misma pausa no manda otro aviso', async () => {
      const f = await tenantWithHours(WEEKDAYS);
      const derive = () =>
        handOff(db, {
          tenantId: f.tenantId,
          conversationId: f.conversationId,
          reason: 'complaint',
          summary: 'Se quejó del turno de ayer',
          now: mendoza('2026-10-09', '10:00'),
        });

      await derive();
      await derive();

      expect(await noticesOf(f.tenantId)).toHaveLength(1);
    });

    it('sin aviso cuando quien deriva ya sabe (la dueña acaba de tocar «No llegó»)', async () => {
      const f = await tenantWithHours(WEEKDAYS);

      await handOff(db, {
        tenantId: f.tenantId,
        conversationId: f.conversationId,
        reason: 'payment_issue',
        summary: 'La transferencia de la seña no llegó',
        now: mendoza('2026-10-09', '10:00'),
        notifyOwner: false,
      });

      expect(await handoffsOf(f.tenantId, f.conversationId)).toHaveLength(1);
      expect(await noticesOf(f.tenantId)).toEqual([]);
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
