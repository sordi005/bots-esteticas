import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../../shared/db.js';
import { decryptSecret, encryptSecret } from '../../shared/encryption.js';
import { tenantCredentials, type credentialKind } from './schema.js';

/**
 * Credenciales de terceros de cada negocio (WhatsApp, Mercado Pago, Google), cifradas con
 * AES-256-GCM (sección 9.1). El contexto del cifrado es "negocio:tipo": una credencial
 * copiada a la fila de otro negocio no se puede descifrar. Nunca se loguean.
 */
export type CredentialKind = (typeof credentialKind.enumValues)[number];

const contextOf = (tenantId: string, kind: CredentialKind) => `${tenantId}:${kind}`;

/** Guarda o reemplaza la credencial. `value` se guarda como JSON cifrado. */
export async function saveCredential(
  db: Queryable,
  key: Buffer,
  input: { tenantId: string; kind: CredentialKind; value: unknown; expiresAt?: Date | null },
): Promise<void> {
  const { tenantId, kind } = input;
  const encrypted = encryptSecret(JSON.stringify(input.value), key, contextOf(tenantId, kind));
  const expiresAt = input.expiresAt ?? null;

  await db
    .insert(tenantCredentials)
    .values({ tenantId, kind, ...encrypted, expiresAt })
    .onConflictDoUpdate({
      target: [tenantCredentials.tenantId, tenantCredentials.kind],
      set: { ...encrypted, expiresAt },
    });
}

/** La credencial descifrada, o null si el negocio no la tiene. Lanza si no se puede descifrar. */
export async function loadCredential(
  db: Queryable,
  key: Buffer,
  input: { tenantId: string; kind: CredentialKind },
): Promise<unknown> {
  const { tenantId, kind } = input;
  const [row] = await db
    .select()
    .from(tenantCredentials)
    .where(and(eq(tenantCredentials.tenantId, tenantId), eq(tenantCredentials.kind, kind)));
  if (!row) return null;

  return JSON.parse(decryptSecret(row, key, contextOf(tenantId, kind))) as unknown;
}
