import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCredential, saveCredential } from '../../src/modules/tenants/credentials.js';
import { tenantCredentials } from '../../src/modules/tenants/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const key = randomBytes(32);
const TOKEN = 'EAAG-token-de-prueba-que-nunca-se-ve';

afterAll(() => database.close());

describe('credenciales de terceros cifradas (sección 9.1)', () => {
  it('se guardan y se leen por negocio y tipo', async () => {
    const { tenantId } = await createTenantFixture(db);

    await saveCredential(db, key, { tenantId, kind: 'whatsapp', value: { accessToken: TOKEN } });

    expect(await loadCredential(db, key, { tenantId, kind: 'whatsapp' })).toEqual({ accessToken: TOKEN });
    expect(await loadCredential(db, key, { tenantId, kind: 'mercadopago' })).toBeNull();
  });

  it('en la base nunca queda el secreto en claro', async () => {
    const { tenantId } = await createTenantFixture(db);
    await saveCredential(db, key, { tenantId, kind: 'whatsapp', value: { accessToken: TOKEN } });

    const row = single(
      await db.select().from(tenantCredentials).where(eq(tenantCredentials.tenantId, tenantId)),
    );
    expect(row.ciphertext.toString('latin1')).not.toContain('EAAG');
  });

  it('guardar de nuevo reemplaza la credencial anterior', async () => {
    const { tenantId } = await createTenantFixture(db);
    await saveCredential(db, key, { tenantId, kind: 'whatsapp', value: { accessToken: 'viejo' } });
    await saveCredential(db, key, { tenantId, kind: 'whatsapp', value: { accessToken: 'nuevo' } });

    expect(await loadCredential(db, key, { tenantId, kind: 'whatsapp' })).toEqual({ accessToken: 'nuevo' });
  });

  it('un negocio no lee la credencial de otro (regla 1)', async () => {
    const a = await createTenantFixture(db);
    const b = await createTenantFixture(db);
    await saveCredential(db, key, { tenantId: a.tenantId, kind: 'whatsapp', value: { accessToken: TOKEN } });

    expect(await loadCredential(db, key, { tenantId: b.tenantId, kind: 'whatsapp' })).toBeNull();
  });

  it('una credencial copiada a la fila de otro negocio no se puede descifrar', async () => {
    const a = await createTenantFixture(db);
    const b = await createTenantFixture(db);
    await saveCredential(db, key, { tenantId: a.tenantId, kind: 'whatsapp', value: { accessToken: TOKEN } });
    const stolen = single(
      await db
        .select()
        .from(tenantCredentials)
        .where(and(eq(tenantCredentials.tenantId, a.tenantId), eq(tenantCredentials.kind, 'whatsapp'))),
    );

    await db.insert(tenantCredentials).values({
      tenantId: b.tenantId,
      kind: 'whatsapp',
      ciphertext: stolen.ciphertext,
      iv: stolen.iv,
      authTag: stolen.authTag,
    });

    await expect(loadCredential(db, key, { tenantId: b.tenantId, kind: 'whatsapp' })).rejects.toThrow();
  });
});
