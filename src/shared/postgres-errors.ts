/** Códigos de error de Postgres que el código maneja (SQLSTATE). */
export const FOREIGN_KEY_VIOLATION = '23503';
export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';
/** Una restricción de exclusión, por ejemplo dos turnos superpuestos (sección 6.6). */
export const EXCLUSION_VIOLATION = '23P01';
/**
 * Postgres abortó la transacción porque esperaba a otra que la esperaba a ella. Con una restricción
 * de exclusión pasa cuando dos transacciones insertan a la vez filas que chocan (sección 6.6).
 */
export const DEADLOCK_DETECTED = '40P01';

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

/**
 * Corre `run` y, si Postgres la abortó por un deadlock, la corre una vez más, como recomienda su
 * documentación. Dos reservas del mismo horario a la vez pueden terminar así en vez de en la
 * violación de `appointments_no_overlap`: en el segundo intento la otra ya terminó, y la que perdió
 * recibe la violación de siempre ("ese horario se acaba de ocupar", 6.6).
 */
export async function retryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (findPostgresError(error)?.code !== DEADLOCK_DETECTED) throw error;
    return run();
  }
}
