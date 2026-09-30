import type { depositRequirement } from '../tenants/schema.js';

/**
 * Cálculo de la seña (sección 4.5). Función pura.
 * La regla del negocio vale para todos los servicios salvo que el servicio tenga la suya.
 */
export type DepositRequirement = (typeof depositRequirement.enumValues)[number];

export interface DepositRule {
  requirement: DepositRequirement;
  /** Porcentaje del precio de lista, o… */
  percentage: number | null;
  /** …un monto fijo. Nunca los dos. */
  fixedAmountCents: number | null;
}

/** Lo que el servicio define por su cuenta. Null = hereda del negocio. */
export interface DepositRuleOverride {
  requirement: DepositRequirement | null;
  percentage: number | null;
  fixedAmountCents: number | null;
}

export function resolveDepositRule(business: DepositRule, service: DepositRuleOverride): DepositRule {
  const serviceDefinesAmount = service.percentage !== null || service.fixedAmountCents !== null;
  return {
    requirement: service.requirement ?? business.requirement,
    percentage: serviceDefinesAmount ? service.percentage : business.percentage,
    fixedAmountCents: serviceDefinesAmount ? service.fixedAmountCents : business.fixedAmountCents,
  };
}

/** Historial de la clienta en este negocio. */
export interface CustomerDepositHistory {
  completedAppointments: number;
  noShowCount: number;
}

const PESO = 100;

/**
 * Monto de la seña en centavos, o null si este turno no lleva seña.
 * El porcentaje se calcula sobre el precio de lista y se redondea hacia arriba al peso.
 */
export function depositAmountCents(input: {
  rule: DepositRule;
  priceCents: number;
  customer: CustomerDepositHistory;
}): number | null {
  const { rule, priceCents, customer } = input;
  if ((rule.percentage === null) === (rule.fixedAmountCents === null)) {
    throw new Error('La seña se define con un porcentaje o un monto fijo, uno de los dos');
  }
  if (!requiresDeposit(rule.requirement, customer) || priceCents <= 0) {
    return null;
  }

  if (rule.fixedAmountCents !== null) {
    return Math.min(rule.fixedAmountCents, priceCents);
  }
  const percentage = rule.percentage ?? 0;
  return Math.ceil((priceCents * percentage) / 100 / PESO) * PESO;
}

function requiresDeposit(requirement: DepositRequirement, customer: CustomerDepositHistory): boolean {
  switch (requirement) {
    case 'never':
      return false;
    case 'always':
      return true;
    // Clienta nueva: todavía no tiene ningún turno completado en este negocio.
    case 'new_customers':
      return customer.completedAppointments === 0;
    case 'customers_with_no_shows':
      return customer.noShowCount > 0;
  }
}
