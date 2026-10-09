import type { CatalogProfessional, CatalogService } from '../../catalog/queries.js';
import { formatPesos, truncateText } from '../format.js';
import { choiceIds } from './choice-ids.js';
import {
  MAX_OPTION_DESCRIPTION_LENGTH,
  MAX_OPTION_TITLE_LENGTH,
  type OfferableOption,
} from './tool.js';

/**
 * Cómo se le cuenta un servicio al modelo y a la clienta: los precios y las duraciones salen
 * escritos por el código (6.4), el modelo no calcula ni convierte nada.
 */

type Pricing = Pick<CatalogService, 'priceCents' | 'cashPriceCents' | 'priceType'>;

const FINAL_PRICE_NOTE = 'el precio final lo confirma la profesional';

/** "$18.000 ($16.000 en efectivo o transferencia)"; con precio "desde", aclara que es "desde" (4.1). */
export function describePrice({ priceCents, cashPriceCents, priceType }: Pricing): string {
  const prefix = priceType === 'from' ? 'desde ' : '';
  const list = `${prefix}${formatPesos(priceCents)}`;
  const cash =
    cashPriceCents === null
      ? ''
      : ` (${prefix}${formatPesos(cashPriceCents)} en efectivo o transferencia)`;
  return priceType === 'from' ? `${list}${cash}, ${FINAL_PRICE_NOTE}` : `${list}${cash}`;
}

/** "60 min (con Sofi, 75 min)": la duración del servicio y las profesionales a las que les lleva otra. */
export function describeDuration(
  durationMinutes: number,
  team: readonly Pick<CatalogProfessional, 'name' | 'durationOverrideMinutes'>[],
): string {
  const different = team
    .filter(
      (professional) =>
        professional.durationOverrideMinutes !== null && professional.durationOverrideMinutes !== durationMinutes,
    )
    .map((professional) => `con ${professional.name}, ${String(professional.durationOverrideMinutes)} min`);
  return different.length === 0
    ? `${String(durationMinutes)} min`
    : `${String(durationMinutes)} min (${different.join('; ')})`;
}

/** Un servicio del catálogo, como lo lee el modelo. */
export function serviceContent(service: CatalogService): Record<string, unknown> {
  return {
    id: service.id,
    nombre: service.name,
    categoria: service.category,
    precio: formatPesos(service.priceCents),
    precioEfectivo: service.cashPriceCents === null ? null : formatPesos(service.cashPriceCents),
    tipoPrecio: service.priceType === 'from' ? 'desde' : 'fijo',
    precioTexto: describePrice(service),
    duracionMinutos: service.durationMinutes,
    duracionTexto: describeDuration(service.durationMinutes, service.professionals),
    requiereConsultaPrevia: service.requiresConsultation,
    profesionales: service.professionals.map((professional) => ({
      id: professional.id,
      nombre: professional.name,
      duracionMinutos: professional.durationOverrideMinutes ?? service.durationMinutes,
    })),
  };
}

/**
 * La fila de lista para elegir el servicio. El título entra en un botón (20 caracteres); si el
 * nombre no entra, el nombre completo pasa a la descripción.
 */
export function serviceOption(service: CatalogService): OfferableOption {
  const title = truncateText(service.name, MAX_OPTION_TITLE_LENGTH);
  const price = `${service.priceType === 'from' ? 'desde ' : ''}${formatPesos(service.priceCents)}`;
  const parts = [...(title === service.name ? [] : [service.name]), price, `${String(service.durationMinutes)} min`];
  return {
    id: choiceIds.service(service.id),
    title,
    description: truncateText(parts.join(' · '), MAX_OPTION_DESCRIPTION_LENGTH),
  };
}
