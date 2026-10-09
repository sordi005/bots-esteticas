import { and, asc, between, eq } from 'drizzle-orm';
import type { Queryable } from '../../shared/db.js';
import type { WeeklyBlock } from '../scheduling/availability.js';
import {
  businessInfo,
  businessInfoTopic,
  holidays,
  professionals,
  professionalServices,
  services,
  workingHours,
} from './schema.js';

/**
 * Consultas de solo lectura del catálogo para el asistente (herramientas de H7).
 * Toda consulta filtra por `tenant_id` (CLAUDE.md, regla 1); `holidays` es la única tabla
 * global y se consulta por fecha.
 */

export interface CatalogProfessional {
  id: string;
  name: string;
  /** Si a ella el servicio le lleva otro tiempo (4.1). Null = el del servicio. */
  durationOverrideMinutes: number | null;
}

export interface CatalogService {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  durationMinutes: number;
  bufferMinutes: number;
  priceCents: number;
  cashPriceCents: number | null;
  priceType: (typeof services.$inferSelect)['priceType'];
  requiresConsultation: boolean;
  /** Las profesionales activas que lo hacen, por nombre. Puede estar vacía. */
  professionals: CatalogProfessional[];
}

/** Servicios que el asistente ofrece (visibles), por categoría y nombre. */
export async function listVisibleServices(db: Queryable, tenantId: string): Promise<CatalogService[]> {
  const rows = await db
    .select({
      id: services.id,
      name: services.name,
      aliases: services.aliases,
      category: services.category,
      durationMinutes: services.durationMinutes,
      bufferMinutes: services.bufferMinutes,
      priceCents: services.priceCents,
      cashPriceCents: services.cashPriceCents,
      priceType: services.priceType,
      requiresConsultation: services.requiresConsultation,
    })
    .from(services)
    .where(and(eq(services.tenantId, tenantId), eq(services.visible, true)))
    .orderBy(asc(services.category), asc(services.name), asc(services.id));

  const team = await db
    .select({
      serviceId: professionalServices.serviceId,
      id: professionals.id,
      name: professionals.name,
      durationOverrideMinutes: professionalServices.durationOverrideMinutes,
    })
    .from(professionalServices)
    .innerJoin(
      professionals,
      and(
        eq(professionals.tenantId, professionalServices.tenantId),
        eq(professionals.id, professionalServices.professionalId),
      ),
    )
    .where(and(eq(professionalServices.tenantId, tenantId), eq(professionals.active, true)))
    .orderBy(asc(professionals.name), asc(professionals.id));

  return rows.map((service) => ({
    ...service,
    professionals: team
      .filter((member) => member.serviceId === service.id)
      .map(({ id, name, durationOverrideMinutes }) => ({ id, name, durationOverrideMinutes })),
  }));
}

export type BusinessInfoTopic = (typeof businessInfoTopic.enumValues)[number];

/** El texto que cargó la dueña para ese tema, o null si no cargó nada. */
export async function getBusinessInfo(
  db: Queryable,
  tenantId: string,
  topic: BusinessInfoTopic,
): Promise<string | null> {
  const [row] = await db
    .select({ content: businessInfo.content })
    .from(businessInfo)
    .where(and(eq(businessInfo.tenantId, tenantId), eq(businessInfo.topic, topic)));
  return row?.content ?? null;
}

export interface ProfessionalWeeklyHours {
  id: string;
  name: string;
  /** Horas locales del negocio, como las devuelve la base: "09:00:00". */
  blocks: WeeklyBlock[];
}

/** El horario semanal de las profesionales activas, por nombre. */
export async function getWeeklyHours(db: Queryable, tenantId: string): Promise<ProfessionalWeeklyHours[]> {
  const team = await db
    .select({ id: professionals.id, name: professionals.name })
    .from(professionals)
    .where(and(eq(professionals.tenantId, tenantId), eq(professionals.active, true)))
    .orderBy(asc(professionals.name), asc(professionals.id));

  const blocks = await db
    .select({
      professionalId: workingHours.professionalId,
      weekday: workingHours.weekday,
      start: workingHours.startTime,
      end: workingHours.endTime,
    })
    .from(workingHours)
    .where(eq(workingHours.tenantId, tenantId))
    .orderBy(asc(workingHours.weekday), asc(workingHours.startTime));

  return team.map((professional) => ({
    ...professional,
    blocks: blocks
      .filter((block) => block.professionalId === professional.id)
      .map(({ weekday, start, end }) => ({ weekday, start, end })),
  }));
}

/** Feriados nacionales entre dos fechas locales "AAAA-MM-DD", ambas incluidas. */
export async function listHolidays(
  db: Queryable,
  from: string,
  to: string,
): Promise<{ date: string; name: string }[]> {
  return db
    .select({ date: holidays.date, name: holidays.name })
    .from(holidays)
    .where(between(holidays.date, from, to))
    .orderBy(asc(holidays.date));
}
