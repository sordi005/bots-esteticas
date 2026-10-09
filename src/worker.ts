import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { conversationJobHandler, type Responder } from './modules/conversation/processing.js';
import {
  createJobRunner,
  type JobHandler,
  type JobRunner,
  type JobRunnerOptions,
} from './modules/jobs/runner.js';
import type { JobKind } from './modules/jobs/schema.js';
import type { WhatsAppClient } from './modules/whatsapp/client.js';

export interface WorkerDependencies {
  db: NodePgDatabase;
  logger: Logger;
  now?: () => Date;
  /** Sin esto el worker no procesa conversaciones: en producción, hasta H8 (sin derivación a una persona no se cumple 4.8). */
  conversations?: { client: WhatsAppClient; credentialsKey: Buffer; respond: Responder };
  /** Para ajustar los valores [S] del worker (sección 6.7). */
  options?: Pick<
    JobRunnerOptions,
    'pollIntervalMs' | 'concurrency' | 'leaseMs' | 'timeoutMs' | 'retryPolicy' | 'healthyWithinMs'
  >;
}

/** Arma el worker con un handler por tipo de tarea. No arranca: eso lo hace main.ts. */
export function buildWorker(dependencies: WorkerDependencies): JobRunner {
  const { db, logger, now = () => new Date(), conversations } = dependencies;
  const handlers: Partial<Record<JobKind, JobHandler>> = {};

  if (conversations) {
    handlers.process_conversation = conversationJobHandler({ db, now, ...conversations });
  }

  return createJobRunner({ db, logger, now, handlers, ...dependencies.options });
}
