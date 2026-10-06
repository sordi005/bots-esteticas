import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, instant, updatedAt } from '../../shared/db-columns.js';
import { tenantId } from '../tenants/schema.js';

/** Tipos de tarea (sección 6.7). Cada hito suma el suyo junto con quien lo ejecuta. */
export const jobKind = pgEnum('job_kind', ['process_conversation']);

export const jobStatus = pgEnum('job_status', ['pending', 'running', 'done', 'failed']);

export type JobKind = (typeof jobKind.enumValues)[number];

/**
 * Tareas programadas: una fila por negocio, tipo y clave (sección 6.7). Volver a
 * programar una tarea actualiza su fila, así que dos ejecuciones de la misma tarea
 * nunca corren a la vez: lo garantiza la base, no el código.
 */
export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kind: jobKind('kind').notNull(),
    /** Qué tarea es dentro de su tipo. La de procesar conversación: el id de la conversación. */
    key: text('key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus('status').notNull().default('pending'),
    runAt: instant('run_at').notNull(),
    /** Se programó de nuevo mientras corría: al terminar vuelve a pendiente para esta hora. */
    rerunAt: instant('rerun_at'),
    attempts: integer('attempts').notNull().default(0),
    /** Nunca incluye tokens ni el contenido de los mensajes (sección 10.1). */
    lastError: text('last_error'),
    /** Plazo de la ejecución en curso. Si vence, la tarea se vuelve a tomar. */
    lockedUntil: instant('locked_until'),
    /** Cambia en cada ejecución: solo quien la tomó puede cerrarla. */
    lockToken: uuid('lock_token'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('scheduled_jobs_tenant_kind_key_key').on(t.tenantId, t.kind, t.key),
    // El worker busca cada segundo las pendientes vencidas y las ejecuciones con el plazo vencido.
    index('scheduled_jobs_due_idx').on(t.runAt).where(sql`${t.status} = 'pending'`),
    index('scheduled_jobs_lease_idx').on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    check(
      'scheduled_jobs_lock_matches_status',
      sql`(${t.status} = 'running') = (${t.lockedUntil} is not null)
        and (${t.status} = 'running') = (${t.lockToken} is not null)`,
    ),
    check(
      'scheduled_jobs_rerun_only_while_running',
      sql`${t.status} = 'running' or ${t.rerunAt} is null`,
    ),
    check('scheduled_jobs_attempts_non_negative', sql`${t.attempts} >= 0`),
  ],
);
