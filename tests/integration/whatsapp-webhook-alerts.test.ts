import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { tenants } from '../../src/modules/tenants/schema.js';
import { alertAccountChanges, alertFailedDeliveries } from '../../src/modules/whatsapp/webhook-alerts.js';
import type { AccountChange } from '../../src/modules/whatsapp/webhook-payload.js';
import { createDatabase } from '../../src/shared/db.js';
import { captureLogs } from '../support/log-capture.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture } from './support/fixtures.js';

/**
 * Alertas que salen del webhook de WhatsApp en el momento (6.5, decisión 59): cambios de la cuenta
 * del negocio y envíos fallidos. No guardan nada.
 */
const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

/** Un negocio con su cuenta de WhatsApp Business (ids aleatorios: la columna es única). */
async function tenantWithAccount() {
  const { tenantId } = await createTenantFixture(db);
  const wabaId = String(randomInt(1e9, 9e9));
  await db.update(tenants).set({ whatsappBusinessAccountId: wabaId }).where(eq(tenants.id, tenantId));
  return { tenantId, wabaId };
}

const templateChange = (wabaId: string, event: string): AccountChange => ({
  kind: 'template_status',
  wabaId,
  event,
  templateId: '1689556908129832',
  templateName: 'recordatorio_turno',
  language: 'es_AR',
  reason: 'INCORRECT_CATEGORY',
});

describe('alertAccountChanges: número desconectado o restringido, plantilla rechazada (10.3)', () => {
  it.each([
    'PARTNER_REMOVED',
    'PARTNER_APP_UNINSTALLED',
    'ACCOUNT_OFFBOARDED',
    'DISABLED_UPDATE',
    'ACCOUNT_RESTRICTION',
    'ACCOUNT_VIOLATION',
    'ACCOUNT_DELETED',
  ])('%s alerta con el negocio de la cuenta', async (event) => {
    const { tenantId, wabaId } = await tenantWithAccount();
    const { logger, alerts } = captureLogs();

    await alertAccountChanges({ db, logger }, [{ kind: 'account_update', wabaId, event }]);

    expect(alerts()).toEqual([expect.objectContaining({ alert: 'account_update', tenantId, detail: event, wabaId })]);
  });

  it('un evento que no corta nada (como PARTNER_ADDED) no alerta', async () => {
    const { wabaId } = await tenantWithAccount();
    const { logger, alerts } = captureLogs();

    await alertAccountChanges({ db, logger }, [{ kind: 'account_update', wabaId, event: 'PARTNER_ADDED' }]);

    expect(alerts()).toEqual([]);
  });

  it('una cuenta que no es de ningún negocio (la del número de avisos) alerta igual, con su id', async () => {
    const { logger, alerts } = captureLogs();

    await alertAccountChanges({ db, logger }, [{ kind: 'account_update', wabaId: '111222333', event: 'PARTNER_REMOVED' }]);

    expect(alerts()).toEqual([
      expect.objectContaining({ alert: 'account_update', tenantId: null, detail: 'PARTNER_REMOVED', wabaId: '111222333' }),
    ]);
  });

  it.each(['REJECTED', 'PAUSED', 'DISABLED', 'FLAGGED'])('una plantilla %s alerta, agrupada por plantilla', async (event) => {
    const { tenantId, wabaId } = await tenantWithAccount();
    const { logger, alerts } = captureLogs();

    await alertAccountChanges({ db, logger }, [templateChange(wabaId, event)]);

    expect(alerts()).toEqual([
      expect.objectContaining({
        alert: 'template_status',
        tenantId,
        detail: `recordatorio_turno:${event}`,
        templateId: '1689556908129832',
        language: 'es_AR',
        reason: 'INCORRECT_CATEGORY',
      }),
    ]);
  });

  it('una plantilla aprobada o en revisión no alerta', async () => {
    const { wabaId } = await tenantWithAccount();
    const { logger, alerts } = captureLogs();

    await alertAccountChanges({ db, logger }, [templateChange(wabaId, 'APPROVED'), templateChange(wabaId, 'PENDING')]);

    expect(alerts()).toEqual([]);
  });
});

describe('alertFailedDeliveries: envíos que Meta no pudo entregar (6.5)', () => {
  it('alerta cada envío fallido, agrupado por negocio y código de error de Meta', () => {
    const { logger, alerts } = captureLogs();
    const tenantId = '0f8b3c2e-6a51-4d4e-9b3f-2c1d0e9a8b7c';

    alertFailedDeliveries(logger, [
      { tenantId, messageId: 'wamid.uno', errors: [{ code: 131026, title: 'Message undeliverable' }] },
      { tenantId, messageId: 'wamid.dos', errors: [] },
    ]);

    expect(alerts()).toEqual([
      expect.objectContaining({ alert: 'delivery_failed', tenantId, detail: '131026', messageId: 'wamid.uno' }),
      expect.objectContaining({ alert: 'delivery_failed', tenantId, detail: 'sin-codigo', messageId: 'wamid.dos' }),
    ]);
  });
});
