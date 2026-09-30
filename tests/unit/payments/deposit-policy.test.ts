import { describe, expect, it } from 'vitest';
import {
  depositAmountCents,
  resolveDepositRule,
  type DepositRule,
} from '../../../src/modules/payments/deposit-policy.js';

const pesos = (amount: number) => amount * 100;

const BUSINESS: DepositRule = { requirement: 'always', percentage: 30, fixedAmountCents: null };
const NO_OVERRIDE = { requirement: null, percentage: null, fixedAmountCents: null };
const NEW_CUSTOMER = { completedAppointments: 0, noShowCount: 0 };
const REGULAR_CUSTOMER = { completedAppointments: 5, noShowCount: 0 };

describe('resolveDepositRule: el servicio puede pisar la regla del negocio', () => {
  it('sin nada propio, el servicio hereda la regla del negocio', () => {
    expect(resolveDepositRule(BUSINESS, NO_OVERRIDE)).toEqual(BUSINESS);
  });

  it('puede cambiar solo a quién se le pide seña', () => {
    expect(resolveDepositRule(BUSINESS, { ...NO_OVERRIDE, requirement: 'never' })).toEqual({
      ...BUSINESS,
      requirement: 'never',
    });
  });

  it('un monto propio reemplaza el del negocio, aunque sea de otro tipo', () => {
    expect(
      resolveDepositRule(BUSINESS, { ...NO_OVERRIDE, fixedAmountCents: pesos(10_000) }),
    ).toEqual({ requirement: 'always', percentage: null, fixedAmountCents: pesos(10_000) });
  });
});

describe('depositAmountCents', () => {
  it('30 % de $18.000 es una seña de $5.400 (ejemplo de la sección 5.4)', () => {
    expect(
      depositAmountCents({ rule: BUSINESS, priceCents: pesos(18_000), customer: REGULAR_CUSTOMER }),
    ).toBe(pesos(5_400));
  });

  it('redondea hacia arriba al peso entero, aunque falten centavos', () => {
    // 30 % de $12.341 = $3.702,30 → $3.703 (el redondeo común daría $3.702)
    expect(
      depositAmountCents({ rule: BUSINESS, priceCents: pesos(12_341), customer: REGULAR_CUSTOMER }),
    ).toBe(pesos(3_703));
  });

  it('usa el monto fijo si la regla lo define', () => {
    const rule: DepositRule = { requirement: 'always', percentage: null, fixedAmountCents: pesos(5_000) };

    expect(depositAmountCents({ rule, priceCents: pesos(18_000), customer: REGULAR_CUSTOMER })).toBe(
      pesos(5_000),
    );
  });

  it('un monto fijo nunca supera el precio del servicio', () => {
    const rule: DepositRule = { requirement: 'always', percentage: null, fixedAmountCents: pesos(10_000) };

    expect(depositAmountCents({ rule, priceCents: pesos(9_000), customer: REGULAR_CUSTOMER })).toBe(
      pesos(9_000),
    );
  });

  it('si el negocio no pide seña, no hay seña', () => {
    expect(
      depositAmountCents({
        rule: { ...BUSINESS, requirement: 'never' },
        priceCents: pesos(18_000),
        customer: NEW_CUSTOMER,
      }),
    ).toBeNull();
  });

  it.each([
    ['nueva', NEW_CUSTOMER, pesos(5_400)],
    ['que ya vino antes', REGULAR_CUSTOMER, null],
  ])('"solo clientas nuevas": a una clienta %s → %s', (_case, customer, expected) => {
    expect(
      depositAmountCents({
        rule: { ...BUSINESS, requirement: 'new_customers' },
        priceCents: pesos(18_000),
        customer,
      }),
    ).toBe(expected);
  });

  it.each([
    ['con una ausencia previa', { completedAppointments: 3, noShowCount: 1 }, pesos(5_400)],
    ['sin ausencias', REGULAR_CUSTOMER, null],
  ])('"solo clientas con ausencias": a una clienta %s → %s', (_case, customer, expected) => {
    expect(
      depositAmountCents({
        rule: { ...BUSINESS, requirement: 'customers_with_no_shows' },
        priceCents: pesos(18_000),
        customer,
      }),
    ).toBe(expected);
  });

  it('un servicio gratis no lleva seña', () => {
    expect(depositAmountCents({ rule: BUSINESS, priceCents: 0, customer: NEW_CUSTOMER })).toBeNull();
  });

  it('rechaza una regla con porcentaje y monto fijo a la vez', () => {
    const rule: DepositRule = { requirement: 'always', percentage: 30, fixedAmountCents: pesos(5_000) };

    expect(() =>
      depositAmountCents({ rule, priceCents: pesos(18_000), customer: NEW_CUSTOMER }),
    ).toThrow(/porcentaje o un monto fijo/);
  });
});
