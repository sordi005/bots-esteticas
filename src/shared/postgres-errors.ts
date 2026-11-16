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
 * Intentos en total de una transacción que Postgres aborta por deadlock. Con cinco reservas del mismo
 * horario a la vez, las que pierden reintentan juntas y pueden volver a trabarse entre sí: un solo
 * reintento no alcanza (falló así en CI). El tope evita reintentar para siempre si algo anda mal.
 */
export const MAX_DEADLOCK_ATTEMPTS = 5;

export interface RetryOnDeadlockOptions {
  /** Espera antes del reintento número `attempt` (1, 2, …). Los tests la reemplazan para no esperar. */
  wait?: (attempt: number) => Promise<void>;
}

/**
 * Entre 0 y 20 ms por intento, al azar: si las que perdieron esperan lo mismo, vuelven a chocar
 * juntas. La espera crece con cada intento para que se separen cada vez más.
 */
function waitWithJitter(attempt: number): Promise<void> {
  const delayMs = Math.random() * 20 * attempt;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Corre `run` y, si Postgres la abortó por un deadlock, la vuelve a correr, como recomienda su
 * documentación: hasta `MAX_DEADLOCK_ATTEMPTS` intentos, con una espera corta al azar entre uno y
 * otro. Varias reservas del mismo horario a la vez pueden terminar así en vez de en la violación de
 * `appointments_no_overlap`: al reintentar, la que ganó ya terminó y la que perdió recibe la
 * violación de siempre ("ese horario se acaba de ocupar", 6.6). Cualquier otro error sube sin
 * reintentar, y también el deadlock del último intento.
 */
export async function retryOnDeadlock<T>(
  run: () => Promise<T>,
  { wait = waitWithJitter }: RetryOnDeadlockOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const isDeadlock = findPostgresError(error)?.code === DEADLOCK_DETECTED;
      if (!isDeadlock || attempt >= MAX_DEADLOCK_ATTEMPTS) throw error;
      await wait(attempt);
    }
  }
}
