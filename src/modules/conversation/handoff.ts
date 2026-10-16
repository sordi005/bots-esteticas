import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Queryable } from '../../shared/db.js';
import { addDaysToLocalDate, instantToLocal } from '../../shared/time-zone.js';
import { listHolidays } from '../catalog/queries.js';
import { loadNoticeCustomer } from '../notifications/notice-data.js';
import { enqueueNotification } from '../notifications/outbox.js';
import { handoffNotice } from '../notifications/texts.js';
import { tenants, tenantSettings } from '../tenants/schema.js';
import {
  ATTENTION_SEARCH_DAYS,
  describeHumanAttention,
  nextHumanAttention,
  type HumanAttention,
} from './attention-hours.js';
import { conversations, handoffs, type handoffReason } from './schema.js';

/**
 * Derivar la conversación a una persona del negocio (4.8). La derivación se registra y el
 * asistente se pausa en una sola transacción: no puede quedar una sin la otra.
 */

export type HandoffReason = (typeof handoffReason.enumValues)[number];

/**
 * [S] Cuánto dura la pausa después de derivar. Hasta que lleguen los ecos de la dueña (H13) se
 * cuenta desde la derivación; en H13 cada eco la corre (4.8). La pausa vence por fecha: no hay tarea.
 */
export const HANDOFF_PAUSE_MS = 12 * 60 * 60 * 1_000;

/** [S] El resumen es de una línea, hasta 200 caracteres (4.8). */
export const HANDOFF_SUMMARY_MAX_LENGTH = 200;
/** Lo único que se guarda de una derivación por un tema de salud (4.8, regla 9). */
export const SENSITIVE_TOPIC_SUMMARY = 'Tema sensible: ver la conversación';

/**
 * El resumen que se guarda. [D] Con un tema sensible el código descarta el del modelo: no depende
 * de que el modelo obedezca el prompt (regla 9: no se guardan datos de salud). Con los demás
 * motivos, queda de una línea y recortado.
 */
export function buildHandoffSummary(reason: HandoffReason, modelSummary: string): string {
  if (reason === 'sensitive_topic') return SENSITIVE_TOPIC_SUMMARY;

  const oneLine = modelSummary.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= HANDOFF_SUMMARY_MAX_LENGTH) return oneLine;
  return `${oneLine.slice(0, HANDOFF_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Cuándo le va a responder una persona al negocio, a partir de su horario de atención humana y
 * de los feriados (4.8). Devuelve el texto listo para decirle a la clienta.
 */
export async function describeWhenHumanReplies(
  db: Queryable,
  input: { tenantId: string; now: Date },
): Promise<string> {
  const { attention, timeZone } = await loadHumanAttention(db, input);
  return describeHumanAttention(attention, timeZone);
}

/**
 * Si en `now` atiende una persona del negocio, o cuándo empieza a atender (4.8), con su horario y
 * sus feriados. Lo usan la derivación y los recordatorios a la dueña (4.5).
 */
export async function loadHumanAttention(
  db: Queryable,
  input: { tenantId: string; now: Date },
): Promise<{ attention: HumanAttention; timeZone: string }> {
  const { tenantId, now } = input;
  const [tenant] = await db
    .select({
      timeZone: tenants.timezone,
      blocks: tenantSettings.humanAttentionHours,
      worksOnHolidays: tenantSettings.worksOnHolidays,
    })
    .from(tenants)
    .leftJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id))
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error('No se encontró el negocio');

  const today = instantToLocal(now, tenant.timeZone).date;
  const holidays = await listHolidays(db, today, addDaysToLocalDate(today, ATTENTION_SEARCH_DAYS));

  const attention: HumanAttention = nextHumanAttention({
    now,
    timeZone: tenant.timeZone,
    blocks: tenant.blocks ?? [],
    holidays: holidays.map((holiday) => holiday.date),
    worksOnHolidays: tenant.worksOnHolidays ?? false,
  });
  return { attention, timeZone: tenant.timeZone };
}

export interface HandOffInput {
  /** Del servidor: el negocio y la conversación nunca los elige el modelo (regla 2). */
  tenantId: string;
  conversationId: string;
  reason: HandoffReason;
  /** Lo que escribió el modelo: con un tema sensible se descarta. */
  summary: string;
  /** La hora actual, inyectada (regla 5). */
  now: Date;
  /**
   * Avisarle a la dueña (por defecto, sí). No hace falta cuando ella misma lo originó: tocó
   * «No llegó» en el aviso de un comprobante (4.5).
   */
  notifyOwner?: boolean;
}

export interface HandOffResult {
  /** La derivación abierta de esta pausa: si ya había una, es esa (no se duplica). */
  handoffId: string;
  /** Cuándo le responde una persona, escrito para la clienta ("en este horario", "el viernes 9/10 a las 9:00"). */
  when: string;
}

export async function handOff(db: NodePgDatabase, input: HandOffInput): Promise<HandOffResult> {
  // Antes de la transacción: si no se puede calcular, no queda una derivación hecha de la que el
  // modelo no se entera (reintentaría y quedaría repetida).
  const when = await describeWhenHumanReplies(db, { tenantId: input.tenantId, now: input.now });

  const handoffId = await db.transaction((tx) => recordHandoff(tx, input));
  return { handoffId, when };
}

/**
 * La derivación en sí, dentro de una transacción abierta: la pausa, el registro y el aviso a la
 * dueña quedan juntos (4.8, 6.7). La usa también quien deriva como parte de otro cambio (la dueña
 * tocó «No llegó», 4.5). Devuelve la derivación abierta de esta pausa: si ya había una, es esa, y
 * no se avisa de nuevo.
 */
export async function recordHandoff(tx: Queryable, input: HandOffInput): Promise<string> {
  const { tenantId, conversationId, reason, now } = input;

  // Se bloquea la conversación: dos derivaciones a la vez (o cancelar fuera de plazo y después
  // derivar, en la misma vuelta) se ordenan y la segunda ve la pausa de la primera.
  const [conversation] = await tx
    .select({
      assistantStatus: conversations.assistantStatus,
      pausedUntil: conversations.pausedUntil,
      customerId: conversations.customerId,
    })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
    .for('update');
  if (!conversation) throw new Error('No se encontró la conversación a derivar');

  // Ya está derivada y la pausa sigue vigente: la derivación abierta es la de esta pausa.
  const pauseIsActive =
    conversation.assistantStatus === 'paused' &&
    (conversation.pausedUntil === null || conversation.pausedUntil.getTime() > now.getTime());
  if (pauseIsActive) {
    const [open] = await tx
      .select({ id: handoffs.id })
      .from(handoffs)
      .where(
        and(
          eq(handoffs.tenantId, tenantId),
          eq(handoffs.conversationId, conversationId),
          eq(handoffs.status, 'open'),
        ),
      )
      .orderBy(desc(handoffs.createdAt))
      .limit(1);
    if (open) return open.id;
  }

  const pausedUntil = new Date(now.getTime() + HANDOFF_PAUSE_MS);
  await tx
    .update(conversations)
    .set({ assistantStatus: 'paused', pausedUntil })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));

  const summary = buildHandoffSummary(reason, input.summary);
  const [handoff] = await tx
    .insert(handoffs)
    .values({ tenantId, conversationId, reason, summary, createdAt: now })
    .returning({ id: handoffs.id });
  if (!handoff) throw new Error('La base no devolvió la derivación');

  if (input.notifyOwner !== false) {
    // El aviso lleva el resumen guardado: con un tema sensible, el fijo (regla 9).
    const notificationId = randomUUID();
    const customer = await loadNoticeCustomer(tx, { tenantId, customerId: conversation.customerId });
    await enqueueNotification(tx, {
      id: notificationId,
      tenantId,
      recipient: 'owner',
      kind: 'handoff',
      customerId: conversation.customerId,
      handoffId: handoff.id,
      message: handoffNotice({ notificationId, appointment: customer, reason, summary, pausedUntil }),
      now,
    });
  }
  return handoff.id;
}
