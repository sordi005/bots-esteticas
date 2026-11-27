/**
 * Errores permanentes (6.7, decisión 55): un tercero que rechaza la credencial (token revocado o
 * vencido, permiso quitado, `invalid_grant`) no se arregla reintentando. Lo decide el cliente de cada
 * tercero: su error expone `rejectedCredential`. El worker no reintenta esa tarea y levanta la alerta
 * de credenciales (10.3).
 */
export const CREDENTIAL_PROVIDERS = ['whatsapp', 'mercadopago', 'google'] as const;

export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

/** Lo implementa el error de cada cliente: qué credencial rechazó el tercero, o null si se reintenta. */
export interface CredentialRejectionSource {
  readonly rejectedCredential: CredentialProvider | null;
}

/** Hasta dónde se siguen las causas: corta una cadena circular. */
const MAX_DEPTH = 5;

function isProvider(value: unknown): value is CredentialProvider {
  return CREDENTIAL_PROVIDERS.includes(value as CredentialProvider);
}

/** La credencial que rechazó un tercero, buscando también en las causas del error. Null: se reintenta. */
export function rejectedCredential(error: unknown): CredentialProvider | null {
  let current = error;
  for (let depth = 0; depth <= MAX_DEPTH && current instanceof Error; depth += 1) {
    const provider = (current as Partial<CredentialRejectionSource>).rejectedCredential;
    if (isProvider(provider)) return provider;
    current = current.cause;
  }
  return null;
}
