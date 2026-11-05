import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { connectProfessionalCalendar } from '../../src/modules/calendar/connection.js';
import { GoogleApiError } from '../../src/modules/calendar/google-auth.js';
import { professionals } from '../../src/modules/catalog/schema.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { tenants } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createBookableFixture, type BookableFixture } from './support/fixtures.js';
import { fakeGoogleCalendar } from './support/google-calendar.js';

/**
 * `pnpm calendar:connect` (8.4, D11): guarda el calendario de una profesional después de verificar
 * que la cuenta de servicio puede leerlo y escribir en él, y programa la primera copia de bloqueos.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = pino({ level: 'silent' });

afterAll(() => database.close());

const NOW = new Date('2026-11-05T15:00:00Z');
const CALENDAR = 'mica@gmail.com';
const DAY_MS = 86_400_000;

async function slugOf(fixture: BookableFixture) {
  const [tenant] = await db.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, fixture.tenantId));
  if (!tenant) throw new Error('Sin negocio');
  return tenant.slug;
}

async function connect(fixture: BookableFixture, google = fakeGoogleCalendar(), professional = 'Mica') {
  const result = await connectProfessionalCalendar(
    { db, logger, now: () => NOW, client: google.client },
    { tenantSlug: await slugOf(fixture), professionalName: professional, calendarId: CALENDAR },
  );
  return { result, google };
}

async function calendarOf(fixture: BookableFixture) {
  const [row] = await db
    .select({ calendarId: professionals.googleCalendarId })
    .from(professionals)
    .where(and(eq(professionals.tenantId, fixture.tenantId), eq(professionals.id, fixture.professionalId)));
  return row?.calendarId;
}

function blocksJobOf(fixture: BookableFixture) {
  return db
    .select({ key: scheduledJobs.key, runAt: scheduledJobs.runAt, status: scheduledJobs.status })
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.tenantId, fixture.tenantId), eq(scheduledJobs.kind, 'sync_calendar_blocks')));
}

describe('connectProfessionalCalendar (D11)', () => {
  it('verifica lectura y escritura con un evento de ayer que borra, guarda el calendario y programa la copia', async () => {
    const fixture = await createBookableFixture(db);

    const { result, google } = await connect(fixture);

    expect(result).toEqual({ status: 'connected' });
    expect(google.listed).toHaveLength(1);
    const [probe] = google.saved;
    expect(probe?.calendarId).toBe(CALENDAR);
    expect(probe?.event.end.getTime()).toBeLessThan(NOW.getTime() - DAY_MS / 2);
    expect(google.deleted).toEqual([{ calendarId: CALENDAR, eventId: probe?.event.id }]);
    expect(await calendarOf(fixture)).toBe(CALENDAR);
    expect(await blocksJobOf(fixture)).toEqual([{ key: fixture.professionalId, runAt: NOW, status: 'pending' }]);
  });

  it('el nombre de la profesional no distingue mayúsculas', async () => {
    const fixture = await createBookableFixture(db);

    const { result } = await connect(fixture, fakeGoogleCalendar(), 'mica');

    expect(result).toEqual({ status: 'connected' });
  });

  it('si no se lo compartieron a la cuenta de servicio, lo dice y no guarda nada', async () => {
    const fixture = await createBookableFixture(db);
    const google = fakeGoogleCalendar({ fail: new GoogleApiError('Not Found', 404, 'notFound'), failOn: 'list' });

    const { result } = await connect(fixture, google);

    expect(result).toEqual({ status: 'not_shared' });
    expect(await calendarOf(fixture)).toBeNull();
    expect(await blocksJobOf(fixture)).toEqual([]);
  });

  it('si se lo compartieron sin "Hacer cambios en eventos", lo dice y no guarda nada', async () => {
    const fixture = await createBookableFixture(db);
    const google = fakeGoogleCalendar({ fail: new GoogleApiError('Forbidden', 403, 'requiredAccessLevel'), failOn: 'save' });

    const { result } = await connect(fixture, google);

    expect(result).toEqual({ status: 'read_only' });
    expect(await calendarOf(fixture)).toBeNull();
  });

  it('un negocio o una profesional que no existen', async () => {
    const fixture = await createBookableFixture(db);

    expect((await connect(fixture, fakeGoogleCalendar(), 'Nadie')).result).toEqual({ status: 'professional_not_found' });
    expect(
      await connectProfessionalCalendar(
        { db, logger, now: () => NOW, client: fakeGoogleCalendar().client },
        { tenantSlug: 'no-existe', professionalName: 'Mica', calendarId: CALENDAR },
      ),
    ).toEqual({ status: 'tenant_not_found' });
  });
});
