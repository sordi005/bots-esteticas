import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Queryable } from '../../shared/db.js';
import { sendWhatsAppMessage } from '../conversation/outbox.js';
import { scheduleJob } from '../jobs/queue.js';
import type { JobHandler } from '../jobs/runner.js';
import { loadCredential } from '../tenants/credentials.js';
import { tenants } from '../tenants/schema.js';
import {
  WhatsAppApiError,
  whatsAppCredentialSchema,
  type WhatsAppClient,
  type WhatsAppMediaClient,
} from '../whatsapp/client.js';
import {
  outgoingMessageSchema,
  templateMessageSchema,
  type OutgoingMessage,
  type TemplateMessage,
} from '../whatsapp/outgoing.js';
import { notifications, type notificationKind, type notificationRecipient } from './schema.js';

/**
 * Outbox de los avisos (6.7, H9). Un aviso se guarda en la misma transacción que el cambio que
 * lo origina (`enqueueNotification`) y lo envía después la tarea `send_notification`, con los
 * reintentos de la cola: un cambio y su aviso no pueden quedar desparejos.
 */

/** Meta: pasaron más de 24 horas desde el último mensaje de la destinataria (8.2). */
export const OUTSIDE_SERVICE_WINDOW = 131047;

export interface NewNotification {
  /** Si ya se sabe (los botones del aviso lo llevan); si no, se genera. */
  id?: string;
  tenantId: string;
  recipient: (typeof notificationRecipient.enumValues)[number];
  kind: (typeof notificationKind.enumValues)[number];
  customerId: string;
  appointmentId?: string;
  depositId?: string;
  handoffId?: string;
  message: OutgoingMessage;
  /** La versión con plantilla, por si el mensaje libre cae fuera de la ventana de 24 horas (H10). */
  template?: TemplateMessage;
  /** El inicio del turno de un recordatorio o un vencimiento: salen una vez por turno e inicio. */
  appointmentStart?: Date;
  /** El comprobante: la imagen en el número del negocio. */
  receiptMediaId?: string;
  now: Date;
}

/** Guarda el aviso y programa su envío para ya. Va dentro de la transacción del cambio. */
export async function enqueueNotification(db: Queryable, notification: NewNotification): Promise<string> {
  const { now, ...values } = notification;
  const id = values.id ?? randomUUID();

  await db.insert(notifications).values({ ...values, id, createdAt: now });
  await scheduleJob(db, {
    tenantId: values.tenantId,
    kind: 'send_notification',
    key: id,
    payload: { notificationId: id },
    runAt: now,
  });
  return id;
}

export interface NotificationSenderDependencies {
  db: NodePgDatabase;
  logger: Logger;
  client: WhatsAppClient & WhatsAppMediaClient;
  credentialsKey: Buffer;
  now: () => Date;
  /** El número de avisos del servicio (8.2). Sin él, los avisos a la dueña salen del número del negocio (fase 0). */
  notificationsNumber?: { phoneNumberId: string; accessToken: string };
  /**
   * Solo en desarrollo (8.1): manda con plantilla todo aviso que la tenga, sin probar antes el mensaje
   * libre. En la demo la dueña y la clienta son el mismo celular, y el 131047 nunca se da solo.
   */
  preferTemplates?: boolean;
}

/** Errores de Meta con la plantilla (no existe, no está aprobada, está pausada, variables que no coinciden). */
const isTemplateError = (code: number | null) => code !== null && code >= 132_000 && code < 133_000;

export type SendNotificationResult = 'sent' | 'failed' | 'already_handled' | 'not_found';

interface Channel {
  phoneNumberId: string;
  accessToken: string;
}

/** El número y el token del negocio, o null si no tiene WhatsApp conectado. */
async function businessChannel(deps: NotificationSenderDependencies, tenantId: string): Promise<Channel | null> {
  const [tenant] = await deps.db
    .select({ phoneNumberId: tenants.whatsappPhoneNumberId })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const credential = whatsAppCredentialSchema.safeParse(
    await loadCredential(deps.db, deps.credentialsKey, { tenantId, kind: 'whatsapp' }),
  );
  if (!tenant?.phoneNumberId || !credential.success) return null;
  return { phoneNumberId: tenant.phoneNumberId, accessToken: credential.data.accessToken };
}

/**
 * Envía un aviso pendiente. Es idempotente: uno ya enviado o fallido no se vuelve a enviar (regla 7).
 *
 * - A la dueña: por el número de avisos (o el del negocio en la fase 0). El comprobante se baja
 *   del número del negocio y se sube al que envía, como encabezado (8.2).
 * - A la clienta: por el número del negocio, y queda en su conversación (el asistente lo ve).
 *
 * Primero sale el mensaje libre; si Meta lo rechaza por estar fuera de la ventana de 24 horas
 * (131047), en la misma ejecución sale su plantilla (6.7, H10). Sin plantilla, sin teléfono de la
 * dueña o con una plantilla que Meta no acepta, queda fallido sin reintentar. Cualquier otro error
 * sube, para que la tarea reintente.
 */
export async function sendNotification(
  deps: NotificationSenderDependencies,
  input: { tenantId: string; notificationId: string },
): Promise<SendNotificationResult> {
  const { db } = deps;
  const { tenantId, notificationId } = input;
  const thisNotification = and(eq(notifications.tenantId, tenantId), eq(notifications.id, notificationId));
  const logger = deps.logger.child({ tenant_id: tenantId, notification_id: notificationId });

  const [notification] = await db.select().from(notifications).where(thisNotification);
  if (!notification) return 'not_found';
  if (notification.status !== 'pending') return 'already_handled';

  const markFailed = async (reason: string): Promise<SendNotificationResult> => {
    // Solo el motivo: el contenido del aviso no va al log (10.1).
    logger.warn({ kind: notification.kind, reason }, 'No se pudo enviar un aviso');
    await db
      .update(notifications)
      .set({ status: 'failed', lastError: reason })
      .where(and(thisNotification, eq(notifications.status, 'pending')));
    return 'failed';
  };

  const message = outgoingMessageSchema.parse(notification.message);
  const template = notification.template ? templateMessageSchema.parse(notification.template) : null;

  /** Envía una versión del aviso: devuelve el id de WhatsApp o, si no se puede enviar, el motivo. */
  let send: (version: OutgoingMessage) => Promise<{ messageId: string } | { failure: string }>;
  if (notification.recipient === 'customer') {
    send = async (version) => {
      const sent = await sendWhatsAppMessage(
        { db, client: deps.client, credentialsKey: deps.credentialsKey, now: deps.now() },
        { tenantId, customerId: notification.customerId, message: version },
      );
      return sent.ok ? { messageId: sent.messageId } : { failure: `No se pudo enviar a la clienta: ${sent.reason}` };
    };
  } else {
    const [tenant] = await db.select({ ownerPhone: tenants.ownerPhone }).from(tenants).where(eq(tenants.id, tenantId));
    const ownerPhone = tenant?.ownerPhone;
    if (!ownerPhone) return await markFailed('El negocio no tiene cargado el teléfono de la dueña');

    const business = await businessChannel(deps, tenantId);
    const channel = deps.notificationsNumber ?? business;
    if (!channel) return await markFailed('El negocio no tiene WhatsApp conectado');

    // La imagen del comprobante se sube una sola vez, aunque salgan las dos versiones.
    let uploadedImageId: string | undefined;
    const receiptMediaId = notification.receiptMediaId;
    send = async (version) => {
      let toSend = version;
      if (receiptMediaId && (version.type === 'buttons' || version.type === 'template')) {
        if (!business) return { failure: 'El negocio no tiene WhatsApp conectado para bajar el comprobante' };
        if (!uploadedImageId) {
          const image = await deps.client.downloadMedia({ mediaId: receiptMediaId, accessToken: business.accessToken });
          ({ mediaId: uploadedImageId } = await deps.client.uploadMedia({ ...channel, ...image }));
        }
        toSend = { ...version, header: { type: 'image', imageId: uploadedImageId } };
      }
      return deps.client.sendMessage({ ...channel, to: ownerPhone, message: toSend });
    };
  }

  const versions: OutgoingMessage[] =
    deps.preferTemplates && template ? [template] : [message, ...(template ? [template] : [])];
  let messageId: string | undefined;
  for (const [index, version] of versions.entries()) {
    try {
      const result = await send(version);
      if ('failure' in result) return await markFailed(result.failure);
      messageId = result.messageId;
      break;
    } catch (error) {
      if (!(error instanceof WhatsAppApiError)) throw error;
      const hasFallback = index < versions.length - 1;
      if (error.code === OUTSIDE_SERVICE_WINDOW && hasFallback) continue;
      if (error.code === OUTSIDE_SERVICE_WINDOW) {
        return await markFailed(`Fuera de la ventana de 24 horas (${String(OUTSIDE_SERVICE_WINDOW)})`);
      }
      if (version.type === 'template' && isTemplateError(error.code)) {
        return await markFailed(`La plantilla ${version.name} no se pudo enviar (${String(error.code)})`);
      }
      throw error;
    }
  }
  if (!messageId) throw new Error('El aviso no tenía ninguna versión para enviar');

  await db
    .update(notifications)
    .set({ status: 'sent', sentAt: deps.now(), whatsappMessageId: messageId })
    .where(and(thisNotification, eq(notifications.status, 'pending')));
  return 'sent';
}

const sendNotificationPayload = z.object({ notificationId: z.uuid() });

/** El handler de las tareas `send_notification` para el worker. */
export function notificationJobHandler(deps: NotificationSenderDependencies): JobHandler {
  return async (job, { signal }) => {
    const payload = sendNotificationPayload.safeParse(job.payload);
    if (!payload.success) {
      throw new Error(`Datos de la tarea inválidos: ${z.prettifyError(payload.error)}`);
    }
    signal.throwIfAborted();
    await sendNotification(deps, { tenantId: job.tenantId, notificationId: payload.data.notificationId });
  };
}
