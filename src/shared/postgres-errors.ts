/** Códigos de error de Postgres que el código maneja (SQLSTATE). */
export const FOREIGN_KEY_VIOLATION = '23503';
export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';
/** Una restricción de exclusión, por ejemplo dos turnos superpuestos (sección 6.6). */
export const EXCLUSION_VIOLATION = '23P01';

export interface PostgresErrorDetails {
  code: string;
  constraint: string | undefined;
}

/** Drizzle envuelve el error del driver: se busca el de Postgres en la cadena de `cause`. */
export function findPostgresError(error: unknown): PostgresErrorDetails | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if ('code' in current && typeof current.code === 'string') {
      const constraint =
        'constraint' in current && typeof current.constraint === 'string'
          ? current.constraint
          : undefined;
      return { code: current.code, constraint };
    }
    current = current.cause;
  }
  return undefined;
}

export function isConstraintViolation(error: unknown, code: string, constraint: string): boolean {
  const details = findPostgresError(error);
  return details?.code === code && details.constraint === constraint;
}
