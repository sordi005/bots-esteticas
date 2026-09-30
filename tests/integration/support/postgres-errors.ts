import { expect } from 'vitest';
import { findPostgresError } from '../../../src/shared/postgres-errors.js';

export {
  CHECK_VIOLATION,
  EXCLUSION_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION,
} from '../../../src/shared/postgres-errors.js';

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
