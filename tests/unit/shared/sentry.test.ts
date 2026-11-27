import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import { DrizzleQueryError } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sentryOptions } from '../../../src/shared/sentry.js';

// Datos de una clienta que nunca pueden llegar a Sentry (10.2 y 9.2).
const PHONE = '+5492615550101';
const NAME = 'Lucía Fernández';

const options = sentryOptions({ dsn: 'https://clave@o1.ingest.de.sentry.io/1', environment: 'test' });

// El beforeSend de producción, y después se guarda lo que habría salido.
const sent: ErrorEvent[] = [];
Sentry.init({
  ...options,
  beforeSend: async (event, hint) => {
    const scrubbed = await options.beforeSend?.(event, hint);
    if (scrubbed) sent.push(scrubbed);
    return null;
  },
});
afterAll(() => Sentry.close());
beforeEach(() => {
  sent.length = 0;
});

function failedInsert(): DrizzleQueryError {
  const cause = new pg.DatabaseError('duplicate key value violates unique constraint "customers_phone"', 90, 'error');
  cause.detail = `Key (phone)=(${PHONE}) already exists.`;
  return new DrizzleQueryError('insert into "customers" ("phone", "name") values ($1, $2)', [PHONE, NAME], cause);
}

describe('sentryOptions: solo errores y sin datos de las clientas (10.2)', () => {
  it('sin medición de rendimiento ni integraciones automáticas', () => {
    expect(options).toMatchObject({ environment: 'test', defaultIntegrations: false });
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.tracesSampler).toBeUndefined();
  });

  it('el mensaje de un error de la base pasa por el mismo filtro que los logs', async () => {
    Sentry.captureException(failedInsert());
    await Sentry.flush(1_000);

    const text = JSON.stringify(sent);
    expect(sent).toHaveLength(1);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(NAME);
    expect(sent[0]?.exception?.values?.map((value) => value.value)).toEqual(
      expect.arrayContaining(['Failed query', 'duplicate key value violates unique constraint "customers_phone"']),
    );
  });

  it('no manda el pedido (cuerpo, headers, query), el usuario ni las migas', async () => {
    Sentry.captureEvent({
      message: 'Falló un pedido',
      level: 'error',
      request: {
        url: 'https://example.com/webhooks/whatsapp',
        data: { text: NAME },
        headers: { authorization: 'Bearer secreto' },
        query_string: 'hub.verify_token=secreto',
        cookies: { sesion: 'secreto' },
      },
      user: { id: PHONE, ip_address: '10.0.0.1' },
      breadcrumbs: [{ message: `mensaje de ${NAME}` }],
    });
    await Sentry.flush(1_000);

    const text = JSON.stringify(sent);
    expect(sent).toHaveLength(1);
    expect(text).not.toContain(NAME);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain('secreto');
    expect(sent[0]?.request).toBeUndefined();
    expect(sent[0]?.user).toBeUndefined();
  });
});
