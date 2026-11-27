import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { alertFingerprint, raiseAlert } from '../../../src/shared/alerts.js';
import { createLogger } from '../../../src/shared/logger.js';

const TENANT_ID = '0f8b3c2e-6a51-4d4e-9b3f-2c1d0e9a8b7c';
const JOB_ID = '5b1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

/** Un logger que guarda las líneas, para leer lo que se logueó. */
function capturingLogger() {
  const lines: string[] = [];
  const logger = createLogger({ logLevel: 'debug' }, { write: (chunk: string) => void lines.push(chunk) });
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, entries };
}

// Sentry con un DSN de mentira: los eventos se leen en beforeSend y nunca salen a la red.
const sent: ErrorEvent[] = [];
Sentry.init({
  dsn: 'https://clave@o1.ingest.de.sentry.io/1',
  defaultIntegrations: false,
  beforeSend: (event) => {
    sent.push(event);
    return null;
  },
});
afterAll(() => Sentry.close());
beforeEach(() => {
  sent.length = 0;
});

describe('raiseAlert: una alerta es un log de error con transporte (10.3)', () => {
  it('se loguea como error, con el tipo, el negocio, el dato que la distingue y los ids', () => {
    const { logger, entries } = capturingLogger();

    raiseAlert(logger, {
      kind: 'job_failed',
      tenantId: TENANT_ID,
      detail: 'send_appointment_reminder',
      ids: { jobId: JOB_ID },
    });

    expect(entries()).toEqual([
      expect.objectContaining({
        level: 50,
        alert: 'job_failed',
        tenantId: TENANT_ID,
        detail: 'send_appointment_reminder',
        jobId: JOB_ID,
        msg: 'Tarea programada fallida: send_appointment_reminder',
      }),
    ]);
  });

  it('manda a Sentry un mensaje de nivel error con la huella del tipo, el negocio y el dato', async () => {
    const { logger } = capturingLogger();

    raiseAlert(logger, {
      kind: 'credential_rejected',
      tenantId: TENANT_ID,
      detail: 'mercadopago',
      ids: { jobId: JOB_ID },
    });
    await Sentry.flush(1_000);

    expect(sent).toEqual([
      expect.objectContaining({
        message: 'Credencial rechazada: mercadopago',
        level: 'error',
        fingerprint: ['credential_rejected', TENANT_ID, 'mercadopago'],
        tags: expect.objectContaining({ alert: 'credential_rejected', tenant_id: TENANT_ID }) as unknown,
        extra: expect.objectContaining({ jobId: JOB_ID }) as unknown,
      }),
    ]);
  });

  it('una alerta que no es de un negocio va sin negocio en la huella', async () => {
    const { logger, entries } = capturingLogger();

    raiseAlert(logger, { kind: 'account_update', tenantId: null, detail: 'PARTNER_REMOVED', ids: { wabaId: '980198427658004' } });
    await Sentry.flush(1_000);

    expect(entries()[0]).toMatchObject({ alert: 'account_update', tenantId: null, wabaId: '980198427658004' });
    expect(sent[0]?.fingerprint).toEqual(['account_update', 'sin-negocio', 'PARTNER_REMOVED']);
  });
});

describe('alertFingerprint: qué eventos junta Sentry en un mismo issue', () => {
  it('el mismo tipo, negocio y dato dan la misma huella; otro negocio, otra', () => {
    const base = { kind: 'delivery_failed', tenantId: TENANT_ID, detail: '131026' } as const;

    expect(alertFingerprint(base)).toEqual(alertFingerprint({ ...base, ids: { messageId: 'otro' } }));
    expect(alertFingerprint(base)).not.toEqual(alertFingerprint({ ...base, tenantId: JOB_ID }));
  });

  it('sin dato, la huella es solo el tipo y el negocio', () => {
    expect(alertFingerprint({ kind: 'holidays_missing', tenantId: TENANT_ID })).toEqual([
      'holidays_missing',
      TENANT_ID,
    ]);
  });
});
