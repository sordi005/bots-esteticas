import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { Queryable } from '../../shared/db.js';
import type { HealthCheck } from '../../shared/health.js';
import { claimJobs, completeJob, failJob, type ClaimedJob } from './queue.js';
import { DEFAULT_RETRY_POLICY, nextRetryAt, type RetryPolicy } from './retry-policy.js';
import type { JobKind } from './schema.js';

/**
 * El worker de tareas programadas (sección 6.7): cada segundo toma las tareas vencidas,
 * las ejecuta con su handler y las cierra o las reprograma. Corre dentro del mismo
 * proceso que el servidor.
 */
export type JobHandler = (job: ClaimedJob, context: { signal: AbortSignal }) => Promise<void>;

export interface JobRunnerOptions {
  db: Queryable;
  logger: Logger;
  /** Un handler por tipo de tarea. Los tipos sin handler no se toman. */
  handlers: Partial<Record<JobKind, JobHandler>>;
  now?: () => Date;
  /** [S] Cada cuánto busca tareas vencidas. */
  pollIntervalMs?: number;
  /** [S] Cuántas tareas ejecuta a la vez. */
  concurrency?: number;
  /** [S] Plazo de una ejecución: si vence, otra vuelta la retoma. Más largo que `timeoutMs`. */
  leaseMs?: number;
  /** [S] Tiempo que tiene un handler para terminar antes de contar como fallo. */
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  /** [S] El worker está sano si completó una vuelta en este tiempo (sección 10.2). */
  healthyWithinMs?: number;
}

export interface JobRunner {
  start(): void;
  /** Deja de tomar tareas y espera a que terminen las que están en curso. */
  stop(): Promise<void>;
  /** Una vuelta: toma lo vencido y espera a que termine. Para tests y herramientas. */
  runOnce(): Promise<void>;
  /** Chequeo de salud para /health. */
  check: HealthCheck;
}

export class JobTimeoutError extends Error {
  override name = 'JobTimeoutError';

  constructor(timeoutMs: number) {
    super(`No terminó dentro de los ${String(timeoutMs)} ms`);
  }
}

const MAX_ERROR_LENGTH = 1_000;

const STALE_JOB_MESSAGE =
  'Una tarea terminó cuando ya había vencido su plazo y otra vuelta la había tomado';

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const {
    db,
    logger,
    handlers,
    now = () => new Date(),
    pollIntervalMs = 1_000,
    concurrency = 5,
    leaseMs = 120_000,
    timeoutMs = 60_000,
    retryPolicy = DEFAULT_RETRY_POLICY,
    healthyWithinMs = 30_000,
  } = options;
  const kinds = (Object.keys(handlers) as JobKind[]).filter((kind) => handlers[kind]);
  const inFlight = new Set<Promise<void>>();
  const stopping = new AbortController();
  let loop: Promise<void> | null = null;
  let lastPollAt = now();

  /** Toma tantas tareas como lugares libres haya y las larga, sin esperar a que terminen. */
  async function poll(): Promise<void> {
    const free = concurrency - inFlight.size;
    const jobs =
      free > 0
        ? await claimJobs(db, {
            kinds,
            limit: free,
            now: now(),
            leaseMs,
            maxAttempts: retryPolicy.maxAttempts,
          })
        : [];
    lastPollAt = now();

    for (const job of jobs) {
      const execution = execute(job);
      inFlight.add(execution);
      void execution.finally(() => inFlight.delete(execution));
    }
  }

  /** Nunca rechaza: todo error queda registrado en la tarea y en el log. */
  async function execute(job: ClaimedJob): Promise<void> {
    const log = logger.child({
      jobId: job.id,
      jobKind: job.kind,
      tenant_id: job.tenantId,
      attempt: job.attempts,
    });

    try {
      await runHandler(job);
    } catch (error) {
      const retryAt = nextRetryAt(job.attempts, now(), retryPolicy);
      try {
        if (!(await failJob(db, job, { error: describeError(error), retryAt }))) {
          log.warn({ err: error }, STALE_JOB_MESSAGE);
        } else if (retryAt) {
          log.warn({ err: error, retryAt }, 'Falló una tarea programada; se reintenta');
        } else {
          log.error({ err: error }, 'Falló una tarea programada y no le quedan intentos');
        }
      } catch (recordError) {
        log.error({ err: recordError }, 'No se pudo registrar el fallo de una tarea programada');
      }
      return;
    }

    try {
      if (!(await completeJob(db, job))) log.warn(STALE_JOB_MESSAGE);
    } catch (recordError) {
      log.error({ err: recordError }, 'No se pudo cerrar una tarea programada');
    }
  }

  /**
   * Corre el handler con un límite de tiempo. Si se pasa, le cancela la señal y cuenta
   * como fallo aunque el handler siga corriendo: el lugar queda libre para otra tarea.
   */
  async function runHandler(job: ClaimedJob): Promise<void> {
    const handler = handlers[job.kind];
    if (!handler) throw new Error(`No hay handler para las tareas de tipo ${job.kind}`);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    const timedOut = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new JobTimeoutError(timeoutMs));
      });
    });

    try {
      await Promise.race([handler(job, { signal: controller.signal }), timedOut]);
    } catch (error) {
      // Un handler que respeta la señal falla con su propio error al cancelarse.
      throw controller.signal.aborted ? new JobTimeoutError(timeoutMs) : error;
    } finally {
      clearTimeout(timer);
    }
    if (controller.signal.aborted) throw new JobTimeoutError(timeoutMs);
  }

  async function waitForInFlight(): Promise<void> {
    await Promise.allSettled([...inFlight]);
  }

  return {
    start() {
      if (loop || stopping.signal.aborted) return;
      // Arranca sano: tiene el plazo de salud entero para completar la primera vuelta.
      lastPollAt = now();
      loop = (async () => {
        while (!stopping.signal.aborted) {
          try {
            await poll();
          } catch (error) {
            logger.error({ err: error }, 'El worker no pudo buscar tareas programadas');
          }
          await sleep(pollIntervalMs, undefined, { signal: stopping.signal }).catch(() => undefined);
        }
      })();
    },

    async stop() {
      stopping.abort();
      await loop;
      await waitForInFlight();
    },

    async runOnce() {
      await poll();
      await waitForInFlight();
    },

    check() {
      if (!loop || stopping.signal.aborted) {
        return Promise.reject(new Error('El worker no está corriendo'));
      }
      const sinceLastPoll = now().getTime() - lastPollAt.getTime();
      if (sinceLastPoll > healthyWithinMs) {
        return Promise.reject(
          new Error(`El worker no completó una vuelta en ${String(sinceLastPoll)} ms`),
        );
      }
      return Promise.resolve();
    },
  };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}
