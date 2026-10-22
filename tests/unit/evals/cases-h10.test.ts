import { describe, expect, it } from 'vitest';
import { choiceIds } from '../../../src/modules/conversation/tools/choice-ids.js';
import { localDateTimeToInstant } from '../../../src/shared/time-zone.js';
import { evalCases } from '../../evals/cases.js';
import { EVAL_TIME_ZONE } from '../../evals/clock.js';
import type { EvalAppointmentState, EvalCase, EvalOption, EvalResult, EvalState } from '../../evals/evaluate.js';

/**
 * Los casos de H10 (los botones del recordatorio y la reserva vencida): qué esperan de la base y de la
 * respuesta. Cada `verifica` se prueba con un estado que pasa y con uno que falla, sin la API.
 */

const SERVICE = '00000000-0000-4000-8000-000000000201';
const MICA = '00000000-0000-4000-8000-000000000101';
const APPOINTMENT_ID = '00000000-0000-4000-8000-0000000000aa';
const SEMI = 'Esmaltado semipermanente';

const at = (date: string, time: string) => localDateTimeToInstant(date, time, EVAL_TIME_ZONE);

function byName(name: string): EvalCase {
  const found = evalCases.find((evalCase) => evalCase.nombre === name);
  if (!found) throw new Error(`No existe el caso ${name}`);
  return found;
}

function friday(overrides: Partial<EvalAppointmentState> = {}): EvalAppointmentState {
  return {
    clave: 'viernes',
    de: 'clienta',
    servicio: SEMI,
    profesional: 'Mica',
    inicio: '2026-10-09 15:00',
    estado: 'CONFIRMED',
    asistenciaConfirmada: false,
    ...overrides,
  };
}

function withState(estado: Partial<EvalState>, options: EvalOption[] = []): EvalResult {
  return {
    texto: 'respuesta',
    tipo: 'text',
    opciones: options,
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

const handedOff: Partial<EvalState> = { derivaciones: [{ motivo: 'customer_request', resumen: 'r' }], pausada: true };

const cancelButton: EvalOption = {
  id: choiceIds.cancel(APPOINTMENT_ID),
  titulo: 'Sí, cancelar',
  descripcion: null,
  resuelta: {
    tipo: 'cancelar',
    turnoId: APPOINTMENT_ID,
    servicioId: SERVICE,
    profesionalId: MICA,
    servicioNombre: SEMI,
    profesionalNombre: 'Mica',
    texto: 'viernes 9/10 15:00',
    estado: 'confirmado',
    ocupaHorario: true,
  },
};

describe('los casos del recordatorio parten del aviso en el historial y su turno confirmado', () => {
  it.each(['recordatorio_confirma', 'recordatorio_reprogramar', 'recordatorio_cancelar', 'recordatorio_no_puedo_ir'])(
    '%s',
    (name) => {
      const { preparar } = byName(name);

      expect(preparar?.historial).toEqual([{ aviso: 'recordatorio', turno: 'viernes' }]);
      expect(preparar?.turnos).toMatchObject([{ clave: 'viernes', inicio: '2026-10-09 15:00', senaAprobada: true }]);
    },
  );
});

describe('recordatorio_confirma', () => {
  it('pasa con la asistencia registrada y el turno igual', () => {
    expect(check('recordatorio_confirma', withState({ turnos: [friday({ asistenciaConfirmada: true })] }))).toBeNull();
  });

  it('falla si no se registró, si el turno cambió o si derivó', () => {
    expect(check('recordatorio_confirma', withState({ turnos: [friday()] }))).toMatch(/no quedó registrada/);
    expect(
      check('recordatorio_confirma', withState({ turnos: [friday({ asistenciaConfirmada: true, estado: 'CANCELLED_BY_CUSTOMER' })] })),
    ).toMatch(/CANCELLED_BY_CUSTOMER/);
    expect(
      check('recordatorio_confirma', withState({ turnos: [friday({ asistenciaConfirmada: true })], ...handedOff })),
    ).toMatch(/derivó/);
  });

  it('no espera que llame a herramientas que cambian el turno', () => {
    expect(byName('recordatorio_confirma').espera.noLlama).toEqual(['cancelar_turno', 'reprogramar_turno', 'crear_reserva']);
  });
});

describe('recordatorio_cancelar', () => {
  it('pasa si ofrece «Sí, cancelar» y el turno sigue confirmado', () => {
    expect(check('recordatorio_cancelar', withState({ turnos: [friday()] }, [cancelButton]))).toBeNull();
  });

  it('falla si canceló sin la confirmación o si no ofreció el botón', () => {
    expect(
      check('recordatorio_cancelar', withState({ turnos: [friday({ estado: 'CANCELLED_BY_CUSTOMER' })] }, [cancelButton])),
    ).toMatch(/CANCELLED_BY_CUSTOMER/);
    expect(check('recordatorio_cancelar', withState({ turnos: [friday()] }))).toMatch(/Sí, cancelar/);
  });
});

describe('recordatorio_no_puedo_ir', () => {
  it('pasa si el turno sigue igual y no derivó', () => {
    expect(check('recordatorio_no_puedo_ir', withState({ turnos: [friday()] }))).toBeNull();
  });

  it('falla si canceló o movió el turno sin que ella eligiera', () => {
    expect(check('recordatorio_no_puedo_ir', withState({ turnos: [friday({ estado: 'CANCELLED_BY_CUSTOMER' })] }))).toMatch(
      /CANCELLED_BY_CUSTOMER/,
    );
    expect(check('recordatorio_no_puedo_ir', withState({ turnos: [friday({ inicio: '2026-10-14 10:00' })] }))).toMatch(
      /2026-10-14 10:00/,
    );
  });
});

describe('reserva_vencida_otro_horario', () => {
  const expired: EvalAppointmentState = {
    clave: 'martes',
    de: 'clienta',
    servicio: SEMI,
    profesional: 'Mica',
    inicio: '2026-10-13 17:00',
    estado: 'EXPIRED',
    asistenciaConfirmada: false,
  };
  const slot: EvalOption = {
    id: choiceIds.slot(SERVICE, MICA, at('2026-10-13', '17:00')),
    titulo: 'mar 13/10 17:00',
    descripcion: null,
    resuelta: {
      tipo: 'horario',
      servicioId: SERVICE,
      servicioNombre: SEMI,
      profesionalId: MICA,
      profesionalNombre: 'Mica',
      inicio: at('2026-10-13', '17:00').toISOString(),
      texto: 'martes 13/10 17:00',
      duracionMinutos: 60,
      sigueLibre: true,
    },
  };

  it('el turno vencido está preparado y el aviso va después de su pedido', () => {
    const { preparar } = byName('reserva_vencida_otro_horario');

    expect(preparar?.turnos).toMatchObject([{ clave: 'martes', vencido: true }]);
    expect(preparar?.historial?.at(-1)).toEqual({ aviso: 'reserva_vencida', turno: 'martes' });
  });

  it('pasa si ofrece horarios libres y no reservó nada', () => {
    expect(check('reserva_vencida_otro_horario', withState({ turnos: [expired] }, [slot]))).toBeNull();
  });

  it('falla si reservó sin que eligiera o si no ofreció horarios', () => {
    const booked: EvalAppointmentState = { ...expired, clave: null, estado: 'PENDING_DEPOSIT' };

    expect(check('reserva_vencida_otro_horario', withState({ turnos: [expired, booked] }, [slot]))).toMatch(/no son los esperados/);
    expect(check('reserva_vencida_otro_horario', withState({ turnos: [expired] }))).toMatch(/No ofreció ningún horario/);
  });
});
