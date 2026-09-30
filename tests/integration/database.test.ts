import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scheduleExceptions } from '../../src/modules/catalog/schema.js';
import { tenantCredentials } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single, type TenantFixture } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

let fixture: TenantFixture;

beforeAll(async () => {
  fixture = await createTenantFixture(db);
});

afterAll(() => database.close());

describe('conexión y tipos contra Postgres real', () => {
  it('la sesión trabaja en UTC (CLAUDE.md, regla 5)', async () => {
    const result = await db.execute<{ timezone: string }>(
      sql`select current_setting('TimeZone') as timezone`,
    );

    expect(result.rows[0]?.timezone).toBe('UTC');
  });

  it('un tstzrange se guarda y se lee con los mismos instantes', async () => {
    const timeRange = {
      start: new Date('2026-12-24T16:00:00.000Z'),
      end: new Date('2026-12-26T12:30:00.500Z'),
    };
    const { id } = single(
      await db
        .insert(scheduleExceptions)
        .values({ tenantId: fixture.tenantId, timeRange, kind: 'closed', reason: 'Navidad' })
        .returning({ id: scheduleExceptions.id }),
    );

    const saved = single(
      await db
        .select({ timeRange: scheduleExceptions.timeRange })
        .from(scheduleExceptions)
        .where(eq(scheduleExceptions.id, id)),
    );

    expect(saved.timeRange).toEqual(timeRange);
  });

  it('las credenciales cifradas se guardan y se leen byte por byte', async () => {
    const encrypted = { ciphertext: randomBytes(48), iv: randomBytes(12), authTag: randomBytes(16) };
    await db.insert(tenantCredentials).values({ tenantId: fixture.tenantId, kind: 'google', ...encrypted });

    const saved = single(
      await db
        .select({
          ciphertext: tenantCredentials.ciphertext,
          iv: tenantCredentials.iv,
          authTag: tenantCredentials.authTag,
        })
        .from(tenantCredentials)
        .where(eq(tenantCredentials.tenantId, fixture.tenantId)),
    );

    expect(saved).toEqual(encrypted);
  });
});
