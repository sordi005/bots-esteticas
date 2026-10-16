import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { conversations, handoffs } from '../../src/modules/conversation/schema.js';
import { depositPaymentTool } from '../../src/modules/conversation/tools/deposit-payment-tool.js';
import { runTool } from '../../src/modules/conversation/tools/tool.js';
import { bookAppointment, changeAppointmentStatus, submitTransferReceipt } from '../../src/modules/scheduling/booking.js';
import { createDatabase } from '../../src/shared/db.js';
import { at, createCatalogFixture, toolContext, type CatalogFixture } from './support/catalog-fixture.js';
import { testDatabaseUrl } from './support/database.js';
import { createCustomer, single } from './support/fixtures.js';

/**
 * `generar_pago_sena(turno_id)` (6.4, 4.5): vuelve a dar los datos para pagar la seña de un turno de
 * la clienta. Los datos y el estado los escribe el código; si no hay cómo cobrar, deriva sola.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

type Fixture = CatalogFixture & { conversationId: string };

async function setup(settings: Parameters<typeof createCatalogFixture>[1] = {}): Promise<Fixture> {
  const catalog = await createCatalogFixture(db, {
    settings: {
      humanAttentionHours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })),
      ...settings.settings,
    },
  });
  const { id: conversationId } = single(
    await db.insert(conversations).values({ tenantId: catalog.tenantId, customerId: catalog.customerId }).returning({ id: conversations.id }),
  );
  return { ...catalog, conversationId };
}

// Se reserva el domingo 4/10 a las 9:00 el martes 6/10 a las 10:00; la seña vence a las 10:00 del domingo.
const BOOKED_AT = at('2026-10-04', '09:00');

async function book(f: Fixture, customerId = f.customerId) {
  const result = await bookAppointment(db, {
    tenantId: f.tenantId,
    customerId,
    serviceId: f.semi,
    professionalId: f.mica,
    start: at('2026-10-06', '10:00'),
    actor: 'assistant',
    now: BOOKED_AT,
  });
  if (!result.ok || !result.deposit) throw new Error('La reserva de prueba no quedó pendiente de seña');
  return { appointmentId: result.appointmentId, depositId: result.deposit.id };
}

const pay = (f: Fixture, turnoId: string, now = at('2026-10-04', '09:30')) =>
  runTool(depositPaymentTool, { turno_id: turnoId }, toolContext(db, f, { conversationId: f.conversationId, now }));

const handoffsOf = (f: Fixture) => db.select().from(handoffs).where(eq(handoffs.conversationId, f.conversationId));

describe('generar_pago_sena: con la seña pendiente', () => {
  it('devuelve los datos de la transferencia escritos por el código, y pide verificar el alias en la respuesta', async () => {
    const f = await setup();
    const { appointmentId } = await book(f);

    const result = await pay(f, `turno:${appointmentId}`);

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({
      turnoId: `turno:${appointmentId}`,
      pago: {
        medio: 'transferencia',
        monto: '$5.400',
        pagarHasta: 'hoy a las 10:00',
        alias: 'estetica.prueba',
        titular: 'Estética Prueba',
      },
    });
    expect(result.mustMention).toBe('estetica.prueba');
    expect(result.changedAppointment).toBeUndefined();
  });

  it('acepta el uuid del turno sin el prefijo', async () => {
    const f = await setup();
    const { appointmentId } = await book(f);

    expect((await pay(f, appointmentId)).content).toHaveProperty('pago');
  });
});

describe('generar_pago_sena: cuando el turno ya no espera la seña', () => {
  it('con el comprobante en verificación lo dice, sin datos para pagar de nuevo', async () => {
    const f = await setup();
    const { appointmentId, depositId } = await book(f);
    await submitTransferReceipt(db, { tenantId: f.tenantId, depositId, mediaId: 'media-1', now: at('2026-10-04', '09:20') });

    const result = await pay(f, appointmentId);

    expect(result.content).not.toHaveProperty('pago');
    expect(JSON.stringify(result.content)).toMatch(/comprobante[^"]*verifica/);
    expect(result.mustMention).toBeUndefined();
  });

  it('con el turno confirmado dice que la seña ya está pagada', async () => {
    const f = await setup();
    const { appointmentId } = await book(f);
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId, to: 'CONFIRMED', actor: 'owner', now: BOOKED_AT });

    const result = await pay(f, appointmentId);

    expect(result.content).not.toHaveProperty('pago');
    expect(JSON.stringify(result.content)).toMatch(/no hay nada para pagar/);
  });

  it('con el plazo vencido no da los datos: el horario se puede liberar', async () => {
    const f = await setup();
    const { appointmentId } = await book(f);

    const result = await pay(f, appointmentId, at('2026-10-04', '11:00'));

    expect(result.content).not.toHaveProperty('pago');
    expect(JSON.stringify(result.content)).toMatch(/venció/);
  });

  it('con el turno cancelado tampoco', async () => {
    const f = await setup();
    const { appointmentId } = await book(f);
    await changeAppointmentStatus(db, { tenantId: f.tenantId, appointmentId, to: 'CANCELLED_BY_CUSTOMER', actor: 'assistant', now: BOOKED_AT });

    expect((await pay(f, appointmentId)).content).not.toHaveProperty('pago');
  });
});

describe('generar_pago_sena: sin cómo cobrar, deriva sola (4.5)', () => {
  it.each([
    ['sin alias ni CBU', { transferAlias: null, transferCbu: null }],
    ['con Mercado Pago (H11)', { depositPaymentOptions: 'mercadopago' as const }],
  ])('%s: no inventa datos y deriva con «pago»', async (_case, settings) => {
    const f = await setup({ settings });
    const { appointmentId } = await book(f);

    const result = await pay(f, appointmentId);

    expect(result.content).toMatchObject({ derivada: true, cuando: 'el lunes 5/10 a las 9:00' });
    expect(result.content).not.toHaveProperty('pago');
    expect(await handoffsOf(f)).toMatchObject([{ reason: 'payment_issue', status: 'open' }]);
  });
});

describe('generar_pago_sena: solo los turnos de esta clienta (regla 2)', () => {
  it('el turno de otra clienta no se ve', async () => {
    const f = await setup();
    const other = await createCustomer(db, f.tenantId);
    const { appointmentId } = await book(f, other);

    const result = await pay(f, appointmentId);

    expect(result.isError).toBe(true);
    expect(result.content).not.toHaveProperty('pago');
  });

  it('un id que no es de un turno es un error para que lo corrija', async () => {
    const f = await setup();

    const result = await pay(f, 'horario:1:2:3');

    expect(result.isError).toBe(true);
  });
});
