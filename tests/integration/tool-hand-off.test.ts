import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { conversations, handoffs } from '../../src/modules/conversation/schema.js';
import { handOffTool } from '../../src/modules/conversation/tools/hand-off.js';
import { runTool } from '../../src/modules/conversation/tools/tool.js';
import { tenantSettings } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, toolContext, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

type Fixture = CatalogFixture & { conversationId: string };

/** Un negocio con atención de lunes a viernes de 9 a 18, y su conversación con la clienta. */
async function setup(): Promise<Fixture> {
  const catalog = await createCatalogFixture(db, {
    settings: {
      humanAttentionHours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })),
    },
  });
  const { id: conversationId } = single(
    await db
      .insert(conversations)
      .values({ tenantId: catalog.tenantId, customerId: catalog.customerId })
      .returning({ id: conversations.id }),
  );
  return { ...catalog, conversationId };
}

// Viernes 9/10/2026 a las 10:00 en Mendoza: dentro del horario de atención.
const NOW = at('2026-10-09', '10:00');

const derive = (f: Fixture, input: unknown, now = NOW) =>
  runTool(handOffTool, input, toolContext(db, f, { conversationId: f.conversationId, now }));

const handoffsOf = (f: Fixture) =>
  db.select().from(handoffs).where(and(eq(handoffs.tenantId, f.tenantId), eq(handoffs.conversationId, f.conversationId)));

describe('derivar_a_persona', () => {
  it.each([
    ['pedido_de_la_clienta', 'customer_request'],
    ['queja', 'complaint'],
    ['tema_sensible', 'sensitive_topic'],
    ['imagen', 'unsupported_media'],
    ['consulta_previa', 'requires_consultation'],
    ['fuera_de_catalogo', 'off_catalog'],
    ['excepcion', 'policy_exception'],
    ['no_entiende', 'not_understood'],
  ] as const)('el motivo "%s" se guarda como %s', async (motivo, stored) => {
    const f = await setup();

    const result = await derive(f, { motivo, resumen: 'Resumen' });

    expect(result.isError).toBeFalsy();
    expect(await handoffsOf(f)).toEqual([expect.objectContaining({ reason: stored, status: 'open' })]);
  });

  it('registra la derivación, pausa el asistente y le dice al modelo cuándo responde una persona', async () => {
    const f = await setup();

    const result = await derive(f, { motivo: 'queja', resumen: 'Se quejó del turno de ayer' });

    expect(result.content).toMatchObject({ derivada: true, cuando: 'en este horario' });
    expect(result.options).toEqual([]);
    const [handoff] = await handoffsOf(f);
    expect(handoff).toMatchObject({ reason: 'complaint', summary: 'Se quejó del turno de ayer' });
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, f.conversationId));
    expect(conversation).toMatchObject({ assistantStatus: 'paused' });
    expect(conversation?.pausedUntil).toEqual(new Date(NOW.getTime() + 12 * 60 * 60 * 1_000));
  });

  it('fuera de horario, el modelo recibe el próximo inicio escrito por el código', async () => {
    const f = await setup();

    const result = await derive(f, { motivo: 'pedido_de_la_clienta', resumen: 'Quiere hablar con alguien' }, at('2026-10-09', '19:30'));

    // El lunes 12/10 es feriado nacional y este negocio no trabaja feriados.
    expect(result.content).toMatchObject({ cuando: 'el martes 13/10 a las 9:00' });
  });

  it('sin horario de atención cargado, "lo antes posible"', async () => {
    const f = await setup();
    await db.update(tenantSettings).set({ humanAttentionHours: [] }).where(eq(tenantSettings.tenantId, f.tenantId));

    const result = await derive(f, { motivo: 'imagen', resumen: 'Mandó una foto' });

    expect(result.content).toMatchObject({ cuando: 'lo antes posible' });
  });

  it('con un tema sensible no se guarda lo que escribió el modelo (regla 9)', async () => {
    const f = await setup();

    await derive(f, { motivo: 'tema_sensible', resumen: 'Está embarazada y toma anticoagulantes' });

    const [handoff] = await handoffsOf(f);
    expect(handoff?.summary).toBe('Tema sensible: ver la conversación');
    expect(JSON.stringify(handoff)).not.toMatch(/embarazada|anticoagulantes/);
  });

  it('un motivo que no está en la lista, o sin resumen, no deriva nada', async () => {
    const f = await setup();

    expect((await derive(f, { motivo: 'porque_si', resumen: 'x' })).isError).toBe(true);
    expect((await derive(f, { motivo: 'queja' })).isError).toBe(true);
    expect((await derive(f, { motivo: 'queja', resumen: '   ' })).isError).toBe(true);

    expect(await handoffsOf(f)).toEqual([]);
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, f.conversationId));
    expect(conversation).toMatchObject({ assistantStatus: 'active', pausedUntil: null });
  });

  it('usa la conversación del servidor: el modelo no puede elegir otra', async () => {
    const f = await setup();
    const other = await setup();

    await derive(f, {
      motivo: 'queja',
      resumen: 'Intento de derivar otra conversación',
      conversacion_id: other.conversationId,
      tenant_id: other.tenantId,
    });

    expect(await handoffsOf(f)).toHaveLength(1);
    expect(await handoffsOf(other)).toEqual([]);
  });
});
