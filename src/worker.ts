import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { depositReminderJobHandler } from './modules/conversation/deposit-receipts.js';
import { ownerReplyJobHandler } from './modules/conversation/owner-replies.js';
import { conversationJobHandler, type Responder } from './modules/conversation/processing.js';
import {
  createJobRunner,
  type JobHandler,
  type JobRunner,
  type JobRunnerOptions,
} from './modules/jobs/runner.js';
import type { JobKind } from './modules/jobs/schema.js';
import { notificationJobHandler, type NotificationSenderDependencies } from './modules/notifications/outbox.js';
import type { WhatsAppClient } from './modules/whatsapp/client.js';

export interface WorkerDependencies {
  db: NodePgDatabase;
  logger: Logger;
  now?: () => Date;
  /** Sin esto el worker no procesa conversaciones. En producción el servidor no arranca sin las claves que hacen falta (9.1). */
  conversations?: { client: WhatsAppClient; credentialsKey: Buffer; respond: Responder };
  /**
   * Sin esto los avisos quedan pendientes: no se envían (6.7, 8.2). `notificationsNumber`: el número de
   * avisos del servicio; sin él, los avisos a la dueña salen del número de cada negocio (fase 0).
   */
  notifications?: Pick<NotificationSenderDependencies, 'client' | 'credentialsKey' | 'notificationsNumber'>;
  /** Para ajustar los valores [S] del worker (sección 6.7). */
  options?: Pick<
    JobRunnerOptions,
    'pollIntervalMs' | 'concurrency' | 'leaseMs' | 'timeoutMs' | 'retryPolicy' | 'healthyWithinMs'
  >;
}

/** Arma el worker con un handler por tipo de tarea. No arranca: eso lo hace main.ts. */
export function buildWorker(dependencies: WorkerDependencies): JobRunner {
  const { db, logger, now = () => new Date(), conversations, notifications } = dependencies;
  const handlers: Partial<Record<JobKind, JobHandler>> = {
    // Los botones de la dueña y los recordatorios solo usan la base: dejan avisos para enviar (H9).
    process_owner_reply: ownerReplyJobHandler({ db, logger, now }),
    remind_deposit_receipt: depositReminderJobHandler({ db, logger, now }),
  };

  if (conversations) {
    handlers.process_conversation = conversationJobHandler({ db, logger, now, ...conversations });
  }
  if (notifications) {
    handlers.send_notification = notificationJobHandler({ db, logger, now, ...notifications });
  }

  return createJobRunner({ db, logger, now, handlers, ...dependencies.options });
}
