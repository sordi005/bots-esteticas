import { and, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../../shared/db.js';
import { scheduledJobs, type JobKind } from './schema.js';

/**
 * Cola de tareas programadas sobre Postgres (sección 6.7). Una fila por negocio, tipo y
 * clave: programar actualiza la fila, tomar la bloquea con un plazo y un token, y solo
 * quien tiene el token puede cerrarla. La hora actual siempre llega por parámetro.
 */
export const EXPIRED_LEASE_ERROR = 'La ejecución anterior no terminó dentro de su plazo';

const MAX_ERROR_LENGTH = 1_000;

export interface ScheduleJobInput {
  tenantId: string;
  kind: JobKind;
  key: string;
  payload?: Record<string, unknown>;
  runAt: Date;
}

/**
 * Programa la tarea para `runAt`. Si ya existía:
 * - pendiente: se mueve a `runAt` (así se agrupan los mensajes seguidos);
 * - en ejecución: no se toca, se anota volver a ejecutarla al terminar;
 * - terminada o fallida: vuelve a pendiente, con los intentos en cero.
 */
export async function scheduleJob(db: Queryable, input: ScheduleJobInput): Promise<void> {
  const isRunning = sql`${scheduledJobs.status} = 'running'`;
  const isFinished = sql`${scheduledJobs.status} in ('done', 'failed')`;

  await db
    .insert(scheduledJobs)
    .values({
      tenantId: input.tenantId,
      kind: input.kind,
      key: input.key,
      payload: input.payload ?? {},
      runAt: input.runAt,
    })
    .onConflictDoUpdate({
      target: [scheduledJobs.tenantId, scheduledJobs.kind, scheduledJobs.key],
      // Todas las expresiones leen la fila como estaba antes de este UPDATE.
      set: {
        payload: sql`excluded.payload`,
        status: sql`case when ${isRunning} then 'running'::job_status else 'pending'::job_status end`,
        runAt: sql`case when ${isRunning} then ${scheduledJobs.runAt} else excluded.run_at end`,
        rerunAt: sql`case when ${isRunning} then excluded.run_at end`,
        attempts: sql`case when ${isFinished} then 0 else ${scheduledJobs.attempts} end`,
        lastError: sql`case when ${isFinished} then null else ${scheduledJobs.lastError} end`,
        updatedAt: sql`now()`,
      },
    });
}

export interface ClaimedJob {
  id: string;
  tenantId: string;
  kind: JobKind;
  key: string;
  payload: unknown;
  /** Contando esta ejecución. */
  attempts: number;
  lockToken: string;
}

export interface ClaimOptions {
  /** Solo se toman los tipos que quien llama sabe ejecutar. */
  kinds: readonly JobKind[];
  limit: number;
  now: Date;
  leaseMs: number;
  maxAttempts: number;
}

/** Una fila tal como la devuelve el SQL de claimJobs, con los nombres de la base. */
interface ClaimedRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  kind: JobKind;
  key: string;
  payload: unknown;
  attempts: number;
  lock_token: string;
}

/**
 * Toma hasta `limit` tareas vencidas: las pendientes cuya hora llegó y las que estaban
 * en ejecución con el plazo vencido (se cayó quien las ejecutaba). `SKIP LOCKED` hace que
 * dos llamadas simultáneas nunca tomen la misma tarea.
 */
export async function claimJobs(db: Queryable, options: ClaimOptions): Promise<ClaimedJob[]> {
  const { kinds, limit, now, leaseMs, maxAttempts } = options;
  if (kinds.length === 0 || limit <= 0) return [];

  const kindList = sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );

  // Una ejecución con el plazo vencido que ya usó todos sus intentos no se vuelve a tomar:
  // queda fallida, igual que si hubiera fallado sin reintento.
  await db.execute(sql`
    update scheduled_jobs set
      status = case when rerun_at is null then 'failed'::job_status else 'pending'::job_status end,
      run_at = coalesce(rerun_at, run_at),
      attempts = case when rerun_at is null then attempts else 0 end,
      last_error = ${EXPIRED_LEASE_ERROR},
      rerun_at = null,
      locked_until = null,
      lock_token = null,
      updated_at = now()
    where status = 'running'
      and locked_until <= ${now}
      and attempts >= ${maxAttempts}
      and kind in (${kindList})
  `);

  // MATERIALIZED: la consulta que bloquea se ejecuta una sola vez. Si Postgres la metiera
  // dentro del UPDATE, podría volver a ejecutarla y tomar más filas que el límite.
  const result = await db.execute<ClaimedRow>(sql`
    with next as materialized (
      select id from scheduled_jobs
      where kind in (${kindList})
        and (
          (status = 'pending' and run_at <= ${now})
          or (status = 'running' and locked_until <= ${now})
        )
      order by run_at
      limit ${limit}
      for update skip locked
    )
    update scheduled_jobs job set
      status = 'running',
      attempts = job.attempts + 1,
      locked_until = ${new Date(now.getTime() + leaseMs)},
      lock_token = gen_random_uuid(),
      last_error = case when job.status = 'running' then ${EXPIRED_LEASE_ERROR} else job.last_error end,
      updated_at = now()
    from next
    where job.id = next.id
    returning job.id, job.tenant_id, job.kind, job.key, job.payload, job.attempts, job.lock_token
  `);

  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    key: row.key,
    payload: row.payload,
    attempts: row.attempts,
    lockToken: row.lock_token,
  }));
}

type JobLock = Pick<ClaimedJob, 'id' | 'lockToken'>;

function heldBy(job: JobLock) {
  return and(
    eq(scheduledJobs.id, job.id),
    eq(scheduledJobs.status, 'running'),
    eq(scheduledJobs.lockToken, job.lockToken),
  );
}

const RELEASE_LOCK = { rerunAt: null, lockedUntil: null, lockToken: null } as const;

/**
 * Cierra una ejecución que terminó bien. Si se programó de nuevo mientras corría, vuelve
 * a pendiente para esa hora. Devuelve false si la tarea ya no era de quien llama.
 */
export async function completeJob(db: Queryable, job: JobLock): Promise<boolean> {
  const rerun = sql`${scheduledJobs.rerunAt} is not null`;
  const updated = await db
    .update(scheduledJobs)
    .set({
      status: sql`case when ${rerun} then 'pending'::job_status else 'done'::job_status end`,
      runAt: sql`coalesce(${scheduledJobs.rerunAt}, ${scheduledJobs.runAt})`,
      attempts: sql`case when ${rerun} then 0 else ${scheduledJobs.attempts} end`,
      lastError: null,
      ...RELEASE_LOCK,
    })
    .where(heldBy(job))
    .returning({ id: scheduledJobs.id });
  return updated.length > 0;
}

/**
 * Registra un intento fallido. Con `retryAt`, vuelve a pendiente para esa hora (o antes,
 * si se programó de nuevo mientras corría). Sin `retryAt`, queda fallida, salvo que se
 * haya programado de nuevo: eso es una vuelta nueva, con los intentos en cero.
 * Devuelve false si la tarea ya no era de quien llama.
 */
export async function failJob(
  db: Queryable,
  job: JobLock,
  outcome: { error: string; retryAt: Date | null },
): Promise<boolean> {
  const rerun = sql`${scheduledJobs.rerunAt} is not null`;
  const lastError = outcome.error.slice(0, MAX_ERROR_LENGTH);

  const updated = await db
    .update(scheduledJobs)
    .set(
      outcome.retryAt
        ? {
            status: 'pending',
            // least() ignora los null: sin una vuelta nueva anotada, queda la del reintento.
            runAt: sql`least(${outcome.retryAt.toISOString()}::timestamptz, ${scheduledJobs.rerunAt})`,
            lastError,
            ...RELEASE_LOCK,
          }
        : {
            status: sql`case when ${rerun} then 'pending'::job_status else 'failed'::job_status end`,
            runAt: sql`coalesce(${scheduledJobs.rerunAt}, ${scheduledJobs.runAt})`,
            attempts: sql`case when ${rerun} then 0 else ${scheduledJobs.attempts} end`,
            lastError,
            ...RELEASE_LOCK,
          },
    )
    .where(heldBy(job))
    .returning({ id: scheduledJobs.id });
  return updated.length > 0;
}
