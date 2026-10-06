export interface RetryPolicy {
  /** Contando el primero. */
  maxAttempts: number;
  /** Espera antes de cada reintento. Si hay más intentos que esperas, se repite la última. */
  retryDelaysMs: readonly number[];
}

/** [S] 3 intentos (la alerta de 10.3 salta con el tercero), a los 30 segundos y a los 2 minutos. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  retryDelaysMs: [30_000, 120_000],
};

/** Cuándo se reintenta una tarea que falló su intento número `attempts`. Null: no se reintenta. */
export function nextRetryAt(
  attempts: number,
  now: Date,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Date | null {
  if (attempts >= policy.maxAttempts) return null;
  const delays = policy.retryDelaysMs;
  const delay = delays[Math.min(attempts, delays.length) - 1] ?? 0;
  return new Date(now.getTime() + delay);
}
