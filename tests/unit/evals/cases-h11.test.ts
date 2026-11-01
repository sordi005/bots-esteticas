import { describe, expect, it } from 'vitest';
import { evalCases } from '../../evals/cases.js';
import type { EvalAppointmentState, EvalCase, EvalResult, EvalState } from '../../evals/evaluate.js';
import { EVAL_PAYMENT_LINK } from '../../evals/payment-link.js';

/**
 * Los casos de H11 (la seña por Mercado Pago): el negocio cobra con Mercado Pago durante el caso, la
 * respuesta trae el link tal cual y nunca pide comprobante. Cada `verifica` se prueba sin la API.
 */

const SEMI = 'Esmaltado semipermanente';
const CASES = ['sena_mercadopago_link_en_reserva', 'sena_mercadopago_pide_link_de_nuevo', 'sena_mercadopago_ya_pague'];

function byName(name: string): EvalCase {
  const found = evalCases.find((evalCase) => evalCase.nombre === name);
  if (!found) throw new Error(`No existe el caso ${name}`);
  return found;
}

function appointment(overrides: Partial<EvalAppointmentState> = {}): EvalAppointmentState {
  return {
    clave: 'martes',
    de: 'clienta',
    servicio: SEMI,
    profesional: 'Mica',
    inicio: '2026-10-13 17:00',
    estado: 'PENDING_DEPOSIT',
    asistenciaConfirmada: false,
    ...overrides,
  };
}

function withState(estado: Partial<EvalState>, texto = 'respuesta'): EvalResult {
  return {
    texto,
    tipo: 'text',
    opciones: [],
    herramientas: [],
    outcome: 'replied',
    tokens: { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 },
    latenciaMs: 1,
    estado: { turnos: [], derivaciones: [], pausada: false, nombreClienta: null, ...estado },
  };
}

function check(name: string, result: EvalResult): string | null {
  const { verifica } = byName(name).espera;
  if (!verifica) throw new Error(`El caso ${name} no tiene verifica`);
  return verifica(result);
}

describe('los casos de Mercado Pago (H11)', () => {
  it.each(CASES)('%s: el negocio cobra con Mercado Pago y la respuesta no pide comprobante', (name) => {
    const evalCase = byName(name);

    expect(evalCase.negocio).toEqual({ sena: 'mercadopago' });
    expect(evalCase.espera.noMenciona).toEqual(expect.arrayContaining(['comprobante', 'alias']));
  });

  it('la reserva y el pedido de nuevo traen el link tal cual', () => {
    expect(byName('sena_mercadopago_link_en_reserva').espera.menciona).toEqual(['5.400', EVAL_PAYMENT_LINK]);
    expect(byName('sena_mercadopago_pide_link_de_nuevo').espera).toMatchObject({
      herramientas: ['generar_pago_sena'],
      menciona: [EVAL_PAYMENT_LINK],
    });
  });

  it('la reserva queda pendiente de seña', () => {
    const reserved = appointment({ clave: null, inicio: '2026-10-09 15:00' });

    expect(check('sena_mercadopago_link_en_reserva', withState({ turnos: [reserved] }))).toBeNull();
    expect(check('sena_mercadopago_link_en_reserva', withState({}))).not.toBeNull();
  });

  it('«ya pagué» sin el aviso de Mercado Pago: el turno sigue pendiente, sin derivar ni darlo por confirmado', () => {
    expect(check('sena_mercadopago_ya_pague', withState({ turnos: [appointment()] }, 'Apenas se acredite te aviso por acá.'))).toBeNull();
    expect(
      check('sena_mercadopago_ya_pague', withState({ turnos: [appointment()] }, '¡Listo! Tu turno quedó confirmado.')),
    ).toMatch(/Afirma un cambio/);
    expect(
      check(
        'sena_mercadopago_ya_pague',
        withState({ turnos: [appointment()], derivaciones: [{ motivo: 'payment_issue', resumen: 'r' }], pausada: true }),
      ),
    ).toMatch(/deriv/);
  });
});
