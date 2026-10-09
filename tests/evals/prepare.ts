import { randomInt, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { professionals, services } from '../../src/modules/catalog/schema.js';
import type { ReceivedMessage } from '../../src/modules/conversation/processing.js';
import { conversations, messages } from '../../src/modules/conversation/schema.js';
import { choiceIds } from '../../src/modules/conversation/tools/choice-ids.js';
import { resolveChoice } from '../../src/modules/conversation/tools/choices.js';
import { customers } from '../../src/modules/customers/schema.js';
import { deposits } from '../../src/modules/payments/schema.js';
import { bookAppointment, changeAppointmentStatus, rescheduleAppointment } from '../../src/modules/scheduling/booking.js';
import { outgoingMessageSchema, type OutgoingMessage } from '../../src/modules/whatsapp/outgoing.js';
import { EVAL_TIME_ZONE } from './clock.js';
import type { EvalAppointmentSetup, EvalCase, EvalChoice, EvalHistoryEntry, EvalInbound } from './evaluate.js';
import { buildInboundMessage } from './inbound.js';
import { parseLocalStart } from './local-time.js';
import { deleteAppointmentsOf } from './state.js';

/**
 * El estado previo de un caso (`EvalCase.preparar`): la clienta con su nombre, sus turnos y los de
 * otras clientas, el historial y los mensajes de la vuelta. Los turnos se crean SOLO con las
 * funciones de `booking.ts`, como en producción (CLAUDE.md): si el caso pide algo que el seed no
 * permite, es un error del caso y se corta con un `EvalPreparationError` que dice qué está mal.
 */

/** Un error del caso de evaluación (un horario que no existe, un nombre mal escrito), no del agente. */
export class EvalPreparationError extends Error {
  override name = 'EvalPreparationError';
}

/** Los turnos se reservan unos minutos antes de la hora de la vuelta: una seña de 60 minutos todavía no venció. */
export const PREPARED_BOOKING_AGE_MS = 10 * 60_000;
/** El historial termina unos minutos antes del primer mensaje de la vuelta. */
const HISTORY_LEAD_MINUTES = 3;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

export interface PrepareDependencies {
  db: NodePgDatabase;
  /** El negocio con los datos de "Estética Ejemplo" ya cargados. */
  tenantId: string;
}

export interface PreparedCase {
  customerId: string;
  conversationId: string;
  /** Los mensajes de la vuelta, guardados como entrantes sin procesar. */
  received: ReceivedMessage[];
  /** Las demás clientas que armó el caso (las dueñas de los turnos de otras). */
  otherCustomerIds: string[];
  /** id del turno → clave con la que lo preparó el caso. */
  appointmentKeys: Map<string, string>;
}

const randomPhone = () => `+549261${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

interface PreparedAppointment {
  id: string;
  ofCaseCustomer: boolean;
}

export async function prepareCase(deps: PrepareDependencies, evalCase: EvalCase, now: Date): Promise<PreparedCase> {
  const { db, tenantId } = deps;
  const setup = evalCase.preparar ?? {};
  const fail = (message: string) =>
    new EvalPreparationError(`No se pudo preparar el caso «${evalCase.nombre}»: ${message}`);

  const [customer] = await db
    .insert(customers)
    .values({ tenantId, phone: randomPhone(), name: setup.nombre ?? null })
    .returning({ id: customers.id });
  if (!customer) throw new Error('No se creó la clienta de la evaluación');
  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId, customerId: customer.id })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error('No se creó la conversación de la evaluación');

  const prepared: PreparedCase = {
    customerId: customer.id,
    conversationId: conversation.id,
    received: [],
    otherCustomerIds: [],
    appointmentKeys: new Map(),
  };

  try {
    await prepareRest({ deps, evalCase, now, prepared, fail });
    return prepared;
  } catch (error) {
    // Lo que se alcanzó a crear de la agenda no puede quedar para el caso siguiente.
    await deleteAppointmentsOf(db, { tenantId, customerIds: [prepared.customerId, ...prepared.otherCustomerIds] });
    throw error;
  }
}

async function prepareRest(input: {
  deps: PrepareDependencies;
  evalCase: EvalCase;
  now: Date;
  prepared: PreparedCase;
  fail: (message: string) => EvalPreparationError;
}): Promise<void> {
  const { deps, evalCase, now, prepared, fail } = input;
  const { db, tenantId } = deps;
  const setup = evalCase.preparar ?? {};

  const serviceIds = await idsByName(db, tenantId, 'services');
  const professionalIds = await idsByName(db, tenantId, 'professionals');
  const serviceId = (name: string) => {
    const id = serviceIds.get(name);
    if (!id) throw fail(`No existe el servicio «${name}» en el seed`);
    return id;
  };
  const professionalId = (name: string) => {
    const id = professionalIds.get(name);
    if (!id) throw fail(`No existe la profesional «${name}» en el seed`);
    return id;
  };
  const parseStart = (text: string) => {
    try {
      return parseLocalStart(text, EVAL_TIME_ZONE);
    } catch (error) {
      throw fail(error instanceof Error ? error.message : String(error));
    }
  };

  // Primero se comprueba que los horarios que toca la clienta existan en el seed, ANTES de crear
  // los turnos del caso: un horario que ocupa otra clienta a propósito (horario_ocupado) es válido.
  const inbound = [
    ...evalCase.mensajes,
    ...(setup.historial ?? []).flatMap((entry) => ('clienta' in entry ? [entry.clienta] : [])),
  ];
  for (const choice of inbound.flatMap(choicesOf)) {
    if (choice.tipo !== 'horario') continue;
    const id = choiceIds.slot(serviceId(choice.servicio), professionalId(choice.profesional), parseStart(choice.inicio));
    const resolved = await resolveChoice(db, { tenantId, customerId: prepared.customerId, now, timeZone: EVAL_TIME_ZONE }, id);
    if (resolved.tipo !== 'horario' || !resolved.sigueLibre) {
      throw fail(
        `el horario de ${choice.servicio} con ${choice.profesional} el ${choice.inicio} no está libre según el seed`,
      );
    }
  }

  // Los turnos, con booking.ts, unos minutos antes de la hora de la vuelta.
  const bookedAt = new Date(now.getTime() - PREPARED_BOOKING_AGE_MS);
  const byKey = new Map<string, PreparedAppointment>();
  const otherCustomers = new Map<string, string>();
  const customerOf = async (name: string | undefined): Promise<string> => {
    if (name === undefined) return prepared.customerId;
    const existing = otherCustomers.get(name);
    if (existing) return existing;
    const [created] = await db
      .insert(customers)
      .values({ tenantId, phone: randomPhone(), name })
      .returning({ id: customers.id });
    if (!created) throw new Error('No se creó la otra clienta de la evaluación');
    otherCustomers.set(name, created.id);
    prepared.otherCustomerIds.push(created.id);
    return created.id;
  };

  for (const appointment of setup.turnos ?? []) {
    const customerId = await customerOf(appointment.otraClienta);
    const id = await createAppointment({ db, tenantId, customerId, appointment, bookedAt, serviceId, professionalId, parseStart, fail });
    // La clave es solo de los turnos que el caso nombra; los demás figuran sin clave en el estado.
    if (appointment.clave !== undefined) {
      prepared.appointmentKeys.set(id, appointment.clave);
      byKey.set(appointment.clave, { id, ofCaseCustomer: appointment.otraClienta === undefined });
    }
  }

  const resolveChoiceId = (choice: EvalChoice): string => {
    if (choice.tipo === 'horario') {
      return choiceIds.slot(serviceId(choice.servicio), professionalId(choice.profesional), parseStart(choice.inicio));
    }
    const appointment = byKey.get(choice.turno);
    if (!appointment) throw fail(`la elección nombra el turno «${choice.turno}», que el caso no preparó`);
    if (!appointment.ofCaseCustomer) {
      throw fail(`el turno «${choice.turno}» es de otra clienta: la clienta del caso no puede tocarlo`);
    }
    return choice.tipo === 'turno' ? choiceIds.appointment(appointment.id) : choiceIds.cancel(appointment.id);
  };

  // El historial: ya procesado, termina unos minutos antes de la hora fija y un minuto separa cada mensaje.
  const history = setup.historial ?? [];
  for (const [index, entry] of history.entries()) {
    const occurredAt = new Date(now.getTime() - (HISTORY_LEAD_MINUTES + history.length - 1 - index) * MINUTE_MS);
    if ('asistente' in entry) {
      await insertOutbound(db, { tenantId, conversationId: prepared.conversationId, entry, occurredAt, fail });
    } else {
      await insertInbound(db, { tenantId, conversationId: prepared.conversationId, inbound: entry.clienta, occurredAt, processed: true, resolveChoiceId });
    }
  }

  // Los mensajes de la vuelta llegan de a un segundo, unos segundos antes de la hora fija.
  for (const [index, message] of evalCase.mensajes.entries()) {
    const occurredAt = new Date(now.getTime() - (evalCase.mensajes.length - index) * SECOND_MS);
    prepared.received.push(
      await insertInbound(db, { tenantId, conversationId: prepared.conversationId, inbound: message, occurredAt, processed: false, resolveChoiceId }),
    );
  }
}

/** Las opciones que toca la clienta en un mensaje (ninguna si es texto o imagen). */
function choicesOf(inbound: EvalInbound): EvalChoice[] {
  return typeof inbound === 'object' && 'eleccion' in inbound ? [inbound.eleccion] : [];
}

async function idsByName(db: NodePgDatabase, tenantId: string, table: 'services' | 'professionals') {
  const source = table === 'services' ? services : professionals;
  const rows = await db.select({ id: source.id, name: source.name }).from(source).where(eq(source.tenantId, tenantId));
  return new Map(rows.map((row) => [row.name, row.id]));
}

async function createAppointment(input: {
  db: NodePgDatabase;
  tenantId: string;
  customerId: string;
  appointment: EvalAppointmentSetup;
  bookedAt: Date;
  serviceId: (name: string) => string;
  professionalId: (name: string) => string;
  parseStart: (text: string) => Date;
  fail: (message: string) => EvalPreparationError;
}): Promise<string> {
  const { db, tenantId, customerId, appointment, bookedAt, fail } = input;
  const starts = [...(appointment.reprogramadoDesde ?? []), appointment.inicio];
  const describe = `el turno de ${appointment.servicio} con ${appointment.profesional}`;

  // Se reserva en el primer inicio y se reprograma hasta el último: cada salto es una reprogramación usada.
  const booked = await bookAppointment(db, {
    tenantId,
    customerId,
    serviceId: input.serviceId(appointment.servicio),
    professionalId: input.professionalId(appointment.profesional),
    start: input.parseStart(starts[0] ?? appointment.inicio),
    actor: 'assistant',
    now: bookedAt,
  });
  if (!booked.ok) throw fail(`${describe} el ${starts[0] ?? appointment.inicio} no se pudo reservar (${booked.reason})`);

  if (appointment.senaAprobada) {
    if (booked.status === 'PENDING_DEPOSIT') {
      const confirmed = await changeAppointmentStatus(db, {
        tenantId,
        appointmentId: booked.appointmentId,
        to: 'CONFIRMED',
        actor: 'owner',
        reason: 'Seña aprobada (preparación de la evaluación)',
        now: bookedAt,
      });
      if (!confirmed.ok) throw fail(`${describe} no se pudo confirmar (${confirmed.reason})`);
    }
    await db
      .update(deposits)
      .set({ status: 'approved' })
      .where(and(eq(deposits.tenantId, tenantId), eq(deposits.appointmentId, booked.appointmentId)));
  }

  for (const start of starts.slice(1)) {
    const moved = await rescheduleAppointment(db, {
      tenantId,
      appointmentId: booked.appointmentId,
      newStart: input.parseStart(start),
      actor: 'assistant',
      reason: 'Reprogramación previa (preparación de la evaluación)',
      now: bookedAt,
    });
    if (!moved.ok) throw fail(`${describe} no se pudo reprogramar al ${start} (${moved.reason})`);
  }
  return booked.appointmentId;
}

async function insertInbound(
  db: NodePgDatabase,
  input: {
    tenantId: string;
    conversationId: string;
    inbound: EvalInbound;
    occurredAt: Date;
    processed: boolean;
    resolveChoiceId: (choice: EvalChoice) => string;
  },
): Promise<ReceivedMessage> {
  const { type, content } = buildInboundMessage(input.inbound, input.resolveChoiceId);
  const [row] = await db
    .insert(messages)
    .values({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      direction: 'inbound',
      type,
      content,
      whatsappMessageId: `wamid.eval.${randomUUID()}`,
      occurredAt: input.occurredAt,
      processedAt: input.processed ? input.occurredAt : null,
    })
    .returning({ id: messages.id });
  if (!row) throw new Error('No se guardó un mensaje de la evaluación');
  return { id: row.id, type, content, occurredAt: input.occurredAt };
}

/** Un mensaje del asistente en el historial: texto, o con botones (hasta 3) o una lista con los títulos de las opciones. */
function outgoingOf(entry: Extract<EvalHistoryEntry, { asistente: string }>): OutgoingMessage {
  const titles = entry.botones ?? [];
  if (titles.length === 0) return { type: 'text', body: entry.asistente };
  if (titles.length <= 3) {
    return {
      type: 'buttons',
      body: entry.asistente,
      buttons: titles.map((title, index) => ({ id: `eval-boton-${String(index)}`, title })),
    };
  }
  return {
    type: 'list',
    body: entry.asistente,
    buttonLabel: 'Ver opciones',
    sections: [{ rows: titles.map((title, index) => ({ id: `eval-fila-${String(index)}`, title })) }],
  };
}

async function insertOutbound(
  db: NodePgDatabase,
  input: {
    tenantId: string;
    conversationId: string;
    entry: Extract<EvalHistoryEntry, { asistente: string }>;
    occurredAt: Date;
    fail: (message: string) => EvalPreparationError;
  },
): Promise<void> {
  const outgoing = outgoingMessageSchema.safeParse(outgoingOf(input.entry));
  if (!outgoing.success) {
    throw input.fail(`el mensaje del asistente «${input.entry.asistente}» no es válido para WhatsApp: ${outgoing.error.message}`);
  }
  await db.insert(messages).values({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    direction: 'outbound',
    type: outgoing.data.type,
    content: outgoing.data,
    occurredAt: input.occurredAt,
  });
}
