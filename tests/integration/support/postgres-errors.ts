import { expect } from 'vitest';

export const FOREIGN_KEY_VIOLATION = '23503';
export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';

interface PostgresErrorDetails {
  code: string;
  constraint: string | undefined;
}

/** Drizzle envuelve el error del driver: se busca el de Postgres en la cadena de `cause`. */
function findPostgresError(error: unknown): PostgresErrorDetails | undefined {
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

/** Verifica que la operación falle por esa restricción puntual de la base, no por otra. */
export async function expectConstraintViolation(
  operation: Promise<unknown>,
  code: string,
  constraint: string,
): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );

  expect(error, `se esperaba que la base rechazara la operación (${constraint})`).toBeDefined();
  expect(findPostgresError(error)).toEqual({ code, constraint });
}
