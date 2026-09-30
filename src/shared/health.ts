export type HealthCheck = () => Promise<void>;

export type CheckStatus = 'ok' | 'error';

export interface HealthReport {
  status: CheckStatus;
  checks: Record<string, CheckStatus>;
}

export interface HealthCheckOptions {
  timeoutMs: number;
  onFailure?: (name: string, error: unknown) => void;
}

/**
 * Corre todos los chequeos en paralelo. Un chequeo que falla o no responde
 * a tiempo cuenta como error, pero no impide reportar los demás.
 */
export async function runHealthChecks(
  checks: Record<string, HealthCheck>,
  options: HealthCheckOptions,
): Promise<HealthReport> {
  const results = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, CheckStatus]> => {
      try {
        await withTimeout(check(), options.timeoutMs);
        return [name, 'ok'];
      } catch (error) {
        options.onFailure?.(name, error);
        return [name, 'error'];
      }
    }),
  );

  return {
    status: results.every(([, status]) => status === 'ok') ? 'ok' : 'error',
    checks: Object.fromEntries(results),
  };
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Sin respuesta en ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
