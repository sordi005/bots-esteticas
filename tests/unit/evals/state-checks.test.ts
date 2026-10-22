import { describe, expect, it } from 'vitest';
import type { EvalAppointmentState, EvalResult, EvalState } from '../../evals/evaluate.js';
import {
  combineChecks,
  verifyAppointment,
  verifyAttendanceConfirmed,
  verifyAppointmentsOf,
  verifyCustomerName,
  verifyHandoff,
  verifyHandoffSummaryWithout,
  verifyMovedOrDerived,
  verifyNotHandedOff,
} from '../../evals/state-checks.js';

const SEMI = 'Esmaltado semipermanente';

function appointment(overrides: Partial<EvalAppointmentState> = {}): EvalAppointmentState {
  return {
    clave: null,
    de: 'clienta',
    servicio: SEMI,
    profesional: 'Mica',
    inicio: '2026-10-09 15:00',
    estado: 'PENDING_DEPOSIT',
    asistenciaConfirmada: false,
    ...overrides,
  };
}

function result(estado: Partial<EvalState> = {}): EvalResult {
  return {
    texto: 'ok',
    tipo: 'text',
    opciones: [],
    herramientas: [],
    outcome: 'replied',
    tokens: { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 },
    latenciaMs: 1,
    estado: { turnos: [], derivaciones: [], pausada: false, nombreClienta: null, ...estado },
  };
}

describe('verifyAppointmentsOf: los turnos de la clienta o de otra', () => {
  const expected = [
    { servicio: SEMI, profesional: 'Mica', inicio: '2026-10-09 15:00', estado: 'PENDING_DEPOSIT' as const },
  ];

  it('pasa si tiene exactamente esos turnos', () => {
    expect(verifyAppointmentsOf(result({ turnos: [appointment()] }), 'clienta', expected)).toBeNull();
  });

  it('sin turnos esperados, pasa solo si no tiene ninguno', () => {
    expect(verifyAppointmentsOf(result(), 'clienta', [])).toBeNull();
    expect(verifyAppointmentsOf(result({ turnos: [appointment()] }), 'clienta', [])).toBe(
      'Los turnos de la clienta no son los esperados. Esperados: ninguno. Quedaron: Esmaltado semipermanente con Mica el 2026-10-09 15:00 (PENDING_DEPOSIT)',
    );
  });

  it('falla si falta el turno, y dice qué esperaba', () => {
    expect(verifyAppointmentsOf(result(), 'clienta', expected)).toBe(
      'Los turnos de la clienta no son los esperados. Esperados: Esmaltado semipermanente con Mica el 2026-10-09 15:00 (PENDING_DEPOSIT). Quedaron: ninguno',
    );
  });

  it.each([
    ['otra hora', { inicio: '2026-10-09 16:00' }],
    ['otra profesional', { profesional: 'Sofi' }],
    ['otro estado', { estado: 'CANCELLED_BY_CUSTOMER' as const }],
    ['otro servicio', { servicio: 'Perfilado de cejas' }],
  ])('falla si el turno tiene %s', (_name, difference) => {
    expect(verifyAppointmentsOf(result({ turnos: [appointment(difference)] }), 'clienta', expected)).toContain(
      'no son los esperados',
    );
  });

  it('falla si hay un turno de más', () => {
    const turnos = [appointment(), appointment({ inicio: '2026-10-09 17:00' })];

    expect(verifyAppointmentsOf(result({ turnos }), 'clienta', expected)).toContain('no son los esperados');
  });

  it('no importa el orden', () => {
    const second = { servicio: SEMI, profesional: 'Sofi', inicio: '2026-10-10 11:00', estado: 'CONFIRMED' as const };
    const turnos = [
      appointment({ profesional: 'Sofi', inicio: '2026-10-10 11:00', estado: 'CONFIRMED' }),
      appointment(),
    ];

    expect(verifyAppointmentsOf(result({ turnos }), 'clienta', [...expected, second])).toBeNull();
  });

  it('mira solo los de la clienta o solo los de otra, según se pida', () => {
    const turnos = [appointment(), appointment({ de: 'otra', inicio: '2026-10-14 11:00' })];

    expect(verifyAppointmentsOf(result({ turnos }), 'clienta', expected)).toBeNull();
    expect(verifyAppointmentsOf(result({ turnos }), 'otra', [])).toContain('Los turnos de otra clienta');
  });
});

describe('verifyAppointment: un turno que preparó el caso', () => {
  const turnos = [appointment({ clave: 'martes', inicio: '2026-10-13 17:00', estado: 'CONFIRMED' })];

  it('pasa si sigue como se esperaba (solo se mira lo que se pide)', () => {
    expect(verifyAppointment(result({ turnos }), 'martes', { estado: 'CONFIRMED' })).toBeNull();
    expect(verifyAppointment(result({ turnos }), 'martes', { inicio: '2026-10-13 17:00' })).toBeNull();
    expect(
      verifyAppointment(result({ turnos }), 'martes', { inicio: '2026-10-13 17:00', estado: 'CONFIRMED' }),
    ).toBeNull();
  });

  it('falla si cambió el estado', () => {
    const cancelled = [appointment({ clave: 'martes', inicio: '2026-10-13 17:00', estado: 'CANCELLED_BY_CUSTOMER' })];

    expect(verifyAppointment(result({ turnos: cancelled }), 'martes', { estado: 'CONFIRMED' })).toBe(
      'El turno «martes» quedó CANCELLED_BY_CUSTOMER y se esperaba CONFIRMED',
    );
  });

  it('falla si cambió el inicio', () => {
    expect(verifyAppointment(result({ turnos }), 'martes', { inicio: '2026-10-14 15:30' })).toBe(
      'El turno «martes» quedó el 2026-10-13 17:00 y se esperaba el 2026-10-14 15:30',
    );
  });

  it('falla si el turno no está', () => {
    expect(verifyAppointment(result({ turnos }), 'otro', { estado: 'CONFIRMED' })).toBe(
      'No está el turno «otro» entre los que preparó el caso',
    );
  });
});

describe('verifyHandoff', () => {
  const handoff = { motivo: 'policy_exception' as const, resumen: 'Pide cancelar fuera de plazo' };

  it('pasa si hay una derivación con ese motivo y la conversación quedó pausada', () => {
    expect(verifyHandoff(result({ derivaciones: [handoff], pausada: true }), 'policy_exception')).toBeNull();
  });

  it('falla si no derivó', () => {
    expect(verifyHandoff(result(), 'complaint')).toBe('No derivó a una persona (se esperaba el motivo complaint)');
  });

  it('falla si derivó por otro motivo y dice cuál', () => {
    expect(verifyHandoff(result({ derivaciones: [handoff], pausada: true }), 'complaint')).toBe(
      'Derivó por policy_exception y se esperaba complaint',
    );
  });

  it('falla si la derivación no pausó la conversación', () => {
    expect(verifyHandoff(result({ derivaciones: [handoff], pausada: false }), 'policy_exception')).toBe(
      'Derivó pero la conversación no quedó pausada',
    );
  });

  it('falla si hay más de una derivación', () => {
    const two = [handoff, { ...handoff, motivo: 'complaint' as const }];

    expect(verifyHandoff(result({ derivaciones: two, pausada: true }), 'policy_exception')).toBe(
      'Se esperaba una sola derivación y hubo 2 (policy_exception, complaint)',
    );
  });
});

describe('verifyMovedOrDerived: el turno se movió o se derivó por la política, y no hay un turno nuevo', () => {
  const expected = { clave: 'martes', movidoA: '2026-10-14 15:30', original: '2026-10-13 17:00' };
  const turn = (inicio: string, overrides: Partial<EvalAppointmentState> = {}) =>
    appointment({ clave: 'martes', inicio, ...overrides });
  const exception = { motivo: 'policy_exception' as const, resumen: 'Pide reprogramar fuera de plazo' };

  it('pasa si el único turno de la clienta quedó en el horario nuevo y no derivó', () => {
    expect(verifyMovedOrDerived(result({ turnos: [turn('2026-10-14 15:30')] }), expected)).toBeNull();
  });

  it('pasa si el único turno sigue donde estaba y se derivó por excepción con la conversación pausada', () => {
    const derived = result({ turnos: [turn('2026-10-13 17:00')], derivaciones: [exception], pausada: true });

    expect(verifyMovedOrDerived(derived, expected)).toBeNull();
  });

  it('falla si la clienta quedó con un turno nuevo además del suyo (reservó en vez de reprogramar)', () => {
    const twoTurns = result({ turnos: [turn('2026-10-13 17:00'), appointment({ inicio: '2026-10-14 15:30' })] });

    expect(verifyMovedOrDerived(twoTurns, expected)).toContain('Se esperaba un solo turno de la clienta y hay 2');
  });

  it('falla si el turno nuevo reemplazó al suyo: el turno «martes» ya no figura', () => {
    const replaced = result({ turnos: [appointment({ inicio: '2026-10-14 15:30' })] });

    expect(verifyMovedOrDerived(replaced, expected)).toContain('«martes»');
  });

  it('falla si el turno se movió y además se derivó, o si quedó donde estaba sin derivar', () => {
    const both = result({ turnos: [turn('2026-10-14 15:30')], derivaciones: [exception], pausada: true });
    const neither = result({ turnos: [turn('2026-10-13 17:00')] });

    expect(verifyMovedOrDerived(both, expected)).toContain('se movió y además derivó');
    expect(verifyMovedOrDerived(neither, expected)).toContain('ni se movió ni se derivó');
  });

  it('falla si el turno quedó en un horario que no es ninguno de los dos', () => {
    expect(verifyMovedOrDerived(result({ turnos: [turn('2026-10-15 10:00')] }), expected)).toContain('2026-10-15 10:00');
  });

  it('falla si el turno se canceló', () => {
    const cancelled = turn('2026-10-13 17:00', { estado: 'CANCELLED_BY_CUSTOMER' });

    expect(verifyMovedOrDerived(result({ turnos: [cancelled], derivaciones: [exception], pausada: true }), expected)).toContain(
      'CANCELLED_BY_CUSTOMER',
    );
  });

  it('ignora los turnos de otras clientas', () => {
    const others = result({ turnos: [turn('2026-10-14 15:30'), appointment({ de: 'otra', inicio: '2026-10-14 11:00' })] });

    expect(verifyMovedOrDerived(others, expected)).toBeNull();
  });
});

describe('verifyNotHandedOff', () => {
  it('pasa si no hay derivaciones ni pausa', () => {
    expect(verifyNotHandedOff(result())).toBeNull();
  });

  it('falla si derivó o si quedó pausada', () => {
    expect(verifyNotHandedOff(result({ derivaciones: [{ motivo: 'complaint', resumen: 'x' }] }))).toBe(
      'No debía derivar y derivó por complaint',
    );
    expect(verifyNotHandedOff(result({ pausada: true }))).toBe('No debía pausar la conversación');
  });
});

describe('verifyHandoffSummaryWithout', () => {
  const withSummary = (resumen: string) => result({ derivaciones: [{ motivo: 'sensitive_topic', resumen }] });

  it('pasa si ningún resumen contiene el texto, sin importar mayúsculas ni tildes', () => {
    expect(verifyHandoffSummaryWithout(withSummary('Tema sensible: ver la conversación'), 'embaraz')).toBeNull();
  });

  it('falla si lo contiene, aunque cambien las mayúsculas', () => {
    expect(verifyHandoffSummaryWithout(withSummary('Consulta por EMBARAZO'), 'embaraz')).toBe(
      'El resumen de la derivación contiene "embaraz": «Consulta por EMBARAZO»',
    );
  });

  it('falla si no hay ninguna derivación (no hay nada que mirar)', () => {
    expect(verifyHandoffSummaryWithout(result(), 'embaraz')).toBe('No hay ninguna derivación para mirar el resumen');
  });
});

describe('verifyCustomerName', () => {
  it('pasa si el nombre guardado es el esperado', () => {
    expect(verifyCustomerName(result({ nombreClienta: 'Caro Pérez' }), 'Caro Pérez')).toBeNull();
  });

  it('falla si no hay nombre o es otro', () => {
    expect(verifyCustomerName(result(), 'Caro Pérez')).toBe('El nombre guardado es ninguno y se esperaba «Caro Pérez»');
    expect(verifyCustomerName(result({ nombreClienta: 'Caro' }), 'Caro Pérez')).toBe(
      'El nombre guardado es «Caro» y se esperaba «Caro Pérez»',
    );
  });
});

describe('combineChecks', () => {
  it('devuelve null si todos pasan', () => {
    expect(combineChecks(null, null)).toBeNull();
    expect(combineChecks()).toBeNull();
  });

  it('junta los motivos de los que fallan, en orden', () => {
    expect(combineChecks('primero', null, 'segundo')).toBe('primero | segundo');
  });

  it('no repite un motivo que dos chequeos dan igual', () => {
    expect(combineChecks('No ofreció ningún horario', 'No ofreció ningún horario')).toBe('No ofreció ningún horario');
    expect(combineChecks('a', 'b', 'a')).toBe('a | b');
  });
});

describe('verifyAttendanceConfirmed: el «Confirmo» del recordatorio quedó registrado (4.7, H10)', () => {
  const tuesday = (asistenciaConfirmada: boolean) => appointment({ clave: 'martes', asistenciaConfirmada });

  it('pasa si quedó como se esperaba', () => {
    expect(verifyAttendanceConfirmed(result({ turnos: [tuesday(true)] }), 'martes', true)).toBeNull();
    expect(verifyAttendanceConfirmed(result({ turnos: [tuesday(false)] }), 'martes', false)).toBeNull();
  });

  it('falla si no se registró, o si se registró sin que correspondiera', () => {
    expect(verifyAttendanceConfirmed(result({ turnos: [tuesday(false)] }), 'martes', true)).toMatch(/no quedó registrada/);
    expect(verifyAttendanceConfirmed(result({ turnos: [tuesday(true)] }), 'martes', false)).toMatch(/quedó registrada/);
  });

  it('falla si el turno no está', () => {
    expect(verifyAttendanceConfirmed(result(), 'martes', true)).toMatch(/No está el turno «martes»/);
  });
});
