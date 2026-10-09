import { describe, expect, it } from 'vitest';
import { choiceIds } from '../../../src/modules/conversation/tools/choice-ids.js';
import { localDateTimeToInstant } from '../../../src/shared/time-zone.js';
import { evalCases } from '../../evals/cases.js';
import { EVAL_TIME_ZONE } from '../../evals/clock.js';
import type { EvalAppointmentState, EvalCase, EvalOption, EvalResult, EvalState } from '../../evals/evaluate.js';

/**
 * Los casos de H8 (reservar, cancelar, reprogramar y derivar): qué esperan de la base y de la
 * respuesta. Cada `verifica` se prueba con un estado que pasa y con uno que falla, sin la API.
 */

const SERVICE = '00000000-0000-4000-8000-000000000201';
const MICA = '00000000-0000-4000-8000-000000000101';
const SEMI = 'Esmaltado semipermanente';

const at = (date: string, time: string) => localDateTimeToInstant(date, time, EVAL_TIME_ZONE);

function byName(name: string): EvalCase {
  const found = evalCases.find((evalCase) => evalCase.nombre === name);
  if (!found) throw new Error(`No existe el caso ${name}`);
  return found;
}

/** Un horario ofrecido, ya resuelto como lo hace la evaluación. */
function offered(start: Date, professional = 'Mica'): EvalOption {
  return {
    id: choiceIds.slot(SERVICE, MICA, start),
    titulo: 'horario',
    descripcion: null,
    resuelta: {
      tipo: 'horario',
      servicioId: SERVICE,
      servicioNombre: SEMI,
      profesionalId: MICA,
      profesionalNombre: professional,
      inicio: start.toISOString(),
      texto: 'texto',
      duracionMinutos: 60,
      sigueLibre: true,
    },
  };
}

function appointment(overrides: Partial<EvalAppointmentState> = {}): EvalAppointmentState {
  return {
    clave: null,
    de: 'clienta',
    servicio: SEMI,
    profesional: 'Mica',
    inicio: '2026-10-09 15:00',
    estado: 'PENDING_DEPOSIT',
    ...overrides,
  };
}

function withState(estado: Partial<EvalState>, options: EvalOption[] = []): EvalResult {
  return {
    texto: 'respuesta',
    tipo: 'list',
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

const handedOff = (motivo: EvalState['derivaciones'][number]['motivo'], resumen = 'resumen'): Partial<EvalState> => ({
  derivaciones: [{ motivo, resumen }],
  pausada: true,
});

describe('fuera_de_catalogo: no deriva de entrada (decisión 25)', () => {
  it('prohíbe llamar a derivar_a_persona', () => {
    expect(byName('fuera_de_catalogo').espera.noLlama).toEqual(['derivar_a_persona']);
  });
});

describe('reserva_completa', () => {
  it('con el turno pendiente de seña en el horario que tocó, pasa', () => {
    expect(check('reserva_completa', withState({ turnos: [appointment()] }))).toBeNull();
  });

  it('sin turno, o con el turno en otro horario, falla', () => {
    expect(check('reserva_completa', withState({}))).toContain('no son los esperados');
    expect(check('reserva_completa', withState({ turnos: [appointment({ inicio: '2026-10-09 16:30' })] }))).toContain(
      'no son los esperados',
    );
  });

  it('espera crear_reserva, el monto de la seña escrito por el código y ni rastro de un alias', () => {
    const { espera } = byName('reserva_completa');

    expect(espera.herramientas).toEqual(['crear_reserva']);
    expect(espera.menciona).toEqual(['5.400']);
    expect(espera.noMenciona).toEqual(['estetica.ejemplo']);
  });

  it('la clienta ya tiene nombre y toca el horario del viernes 9/10 a las 15:00 con Mica', () => {
    const evalCase = byName('reserva_completa');

    expect(evalCase.preparar?.nombre).toBe('Caro Pérez');
    expect(evalCase.mensajes).toEqual([
      {
        eleccion: { tipo: 'horario', servicio: SEMI, profesional: 'Mica', inicio: '2026-10-09 15:00' },
        titulo: 'vie 9/10 15:00',
      },
    ]);
  });
});

describe('reserva_pide_nombre', () => {
  it('pasa si no se creó ningún turno, y falla si se creó', () => {
    expect(check('reserva_pide_nombre', withState({}))).toBeNull();
    expect(check('reserva_pide_nombre', withState({ turnos: [appointment()] }))).toContain('no son los esperados');
  });

  it('la clienta no tiene nombre y el agente tiene que pedirlo', () => {
    const evalCase = byName('reserva_pide_nombre');

    expect(evalCase.preparar?.nombre).toBeUndefined();
    expect(evalCase.espera.menciona).toEqual(['nombre']);
  });
});

describe('reserva_nombre_despues', () => {
  it('pasa con el turno creado y el nombre guardado', () => {
    expect(check('reserva_nombre_despues', withState({ turnos: [appointment()], nombreClienta: 'Caro Pérez' }))).toBeNull();
  });

  it('falla si el turno se creó pero el nombre no quedó guardado', () => {
    expect(check('reserva_nombre_despues', withState({ turnos: [appointment()] }))).toContain('El nombre guardado es ninguno');
  });

  it('el historial tiene la elección del horario y la pregunta por el nombre, y ahora escribe su nombre', () => {
    const evalCase = byName('reserva_nombre_despues');
    const history = evalCase.preparar?.historial ?? [];
    const choices = history.filter(
      (entry) => 'clienta' in entry && typeof entry.clienta === 'object' && 'eleccion' in entry.clienta,
    );

    expect(choices).toHaveLength(1);
    expect(history.at(-1)).toEqual({ asistente: '¿A nombre de quién lo anoto?' });
    expect(evalCase.mensajes).toEqual(['Caro Pérez']);
  });
});

describe('horario_ocupado', () => {
  const MARIA = { clave: 'maria', de: 'otra', inicio: '2026-10-09 15:00' } as const;

  it('pasa si no se creó turno y ofrece otros horarios libres (a la misma hora con Sofi sí se puede)', () => {
    const options = [offered(at('2026-10-09', '16:30')), offered(at('2026-10-09', '15:00'), 'Sofi')];

    expect(check('horario_ocupado', withState({ turnos: [appointment(MARIA)] }, options))).toBeNull();
  });

  it('falla si le reservó el horario que ya tenía otra clienta', () => {
    const turnos = [appointment(MARIA), appointment()];

    expect(check('horario_ocupado', withState({ turnos }, [offered(at('2026-10-09', '16:30'))]))).toContain(
      'no son los esperados',
    );
  });

  it('falla si volvió a ofrecer el horario ocupado, o si no ofreció ninguno', () => {
    const turnos = [appointment(MARIA)];

    expect(check('horario_ocupado', withState({ turnos }, [offered(at('2026-10-09', '15:00'))]))).toContain(
      'ya estaba ocupado',
    );
    expect(check('horario_ocupado', withState({ turnos }))).toContain('No ofreció ningún horario');
  });

  it('otra clienta ya tiene ese horario y la clienta lo toca', () => {
    const evalCase = byName('horario_ocupado');

    expect(evalCase.preparar?.turnos).toEqual([
      { clave: 'maria', servicio: SEMI, profesional: 'Mica', inicio: '2026-10-09 15:00', otraClienta: 'María González' },
    ]);
    expect(evalCase.espera.herramientas).toEqual(['consultar_disponibilidad']);
  });
});

describe('reserva_con_profesional', () => {
  it('pasa si todas las opciones son de Sofi, del viernes 9/10 a la tarde', () => {
    const options = [offered(at('2026-10-09', '13:00'), 'Sofi'), offered(at('2026-10-09', '15:30'), 'Sofi')];

    expect(check('reserva_con_profesional', withState({}, options))).toBeNull();
  });

  it('falla si ofrece un horario con Mica', () => {
    const options = [offered(at('2026-10-09', '15:30'), 'Sofi'), offered(at('2026-10-09', '16:00'))];

    expect(check('reserva_con_profesional', withState({}, options))).toContain('con Mica');
  });

  it('falla si ofrece un horario de la mañana', () => {
    expect(check('reserva_con_profesional', withState({}, [offered(at('2026-10-09', '11:00'), 'Sofi')]))).toContain(
      'Horario fuera de lo pedido',
    );
  });
});

describe('mis_turnos y sin_turnos', () => {
  it('mis_turnos: tiene un turno el martes 13/10 y el agente tiene que listarlo y decir la fecha', () => {
    const evalCase = byName('mis_turnos');

    expect(evalCase.preparar?.turnos?.[0]).toMatchObject({ servicio: SEMI, profesional: 'Mica', inicio: '2026-10-13 17:00' });
    expect(evalCase.espera.herramientas).toEqual(['listar_turnos_de_la_clienta']);
    expect(evalCase.espera.menciona).toEqual(['13/10']);
  });

  it('mis_turnos: el turno no se toca', () => {
    const turno = appointment({ clave: 'martes', inicio: '2026-10-13 17:00' });
    const cancelled = appointment({ clave: 'martes', inicio: '2026-10-13 17:00', estado: 'CANCELLED_BY_CUSTOMER' });

    expect(check('mis_turnos', withState({ turnos: [turno] }))).toBeNull();
    expect(check('mis_turnos', withState({ turnos: [cancelled] }))).toContain('CANCELLED_BY_CUSTOMER');
  });

  it('sin_turnos: no tiene turnos, lista los suyos y no cancela nada', () => {
    const { espera, preparar } = byName('sin_turnos');

    expect(preparar?.turnos).toBeUndefined();
    expect(espera.herramientas).toEqual(['listar_turnos_de_la_clienta']);
    expect(espera.noLlama).toEqual(['cancelar_turno']);
  });
});

describe('turno_de_otra', () => {
  const MARIA = appointment({ clave: 'maria', de: 'otra', inicio: '2026-10-14 11:00' });

  it('pasa si el turno de María sigue como estaba', () => {
    expect(check('turno_de_otra', withState({ turnos: [MARIA] }))).toBeNull();
  });

  it('falla si el turno de María quedó cancelado', () => {
    expect(check('turno_de_otra', withState({ turnos: [{ ...MARIA, estado: 'CANCELLED_BY_CUSTOMER' }] }))).toContain(
      'El turno «maria» quedó CANCELLED_BY_CUSTOMER',
    );
  });

  it('el turno es de María González y la respuesta no cuenta cuándo es', () => {
    const evalCase = byName('turno_de_otra');

    expect(evalCase.preparar?.turnos?.[0]).toMatchObject({ otraClienta: 'María González', inicio: '2026-10-14 11:00' });
    expect(evalCase.espera.noMenciona).toEqual(['14/10']);
  });
});

describe('cancelar_pide_confirmacion', () => {
  const MARTES = appointment({ clave: 'martes', inicio: '2026-10-13 17:00' });
  const cancelButton: EvalOption = {
    id: choiceIds.cancel('00000000-0000-4000-8000-0000000000aa'),
    titulo: 'Sí, cancelar',
    descripcion: null,
    resuelta: {
      tipo: 'cancelar',
      turnoId: '00000000-0000-4000-8000-0000000000aa',
      servicioId: SERVICE,
      profesionalId: MICA,
      servicioNombre: SEMI,
      profesionalNombre: 'Mica',
      texto: 'martes 13/10 17:00',
      estado: 'pendiente de seña',
      ocupaHorario: true,
    },
  };

  it('pasa si el turno sigue activo y ofrece el botón «Sí, cancelar»', () => {
    expect(check('cancelar_pide_confirmacion', withState({ turnos: [MARTES] }, [cancelButton]))).toBeNull();
  });

  it('falla si ya lo canceló sin esperar la confirmación', () => {
    const cancelled = { ...MARTES, estado: 'CANCELLED_BY_CUSTOMER' as const };

    expect(check('cancelar_pide_confirmacion', withState({ turnos: [cancelled] }, [cancelButton]))).toContain(
      'CANCELLED_BY_CUSTOMER',
    );
  });

  it('falla si no ofrece el botón', () => {
    expect(check('cancelar_pide_confirmacion', withState({ turnos: [MARTES] }))).toBe(
      'No ofreció el botón «Sí, cancelar»',
    );
  });
});

describe('cancelar_confirmado', () => {
  it('toca «Sí, cancelar» de su turno del martes después de que el asistente se lo ofreció', () => {
    const evalCase = byName('cancelar_confirmado');

    expect(evalCase.mensajes).toEqual([{ eleccion: { tipo: 'cancelar', turno: 'martes' }, titulo: 'Sí, cancelar' }]);
    expect(evalCase.preparar?.historial?.at(-1)).toMatchObject({ botones: ['Sí, cancelar'] });
    expect(evalCase.espera.herramientas).toEqual(['cancelar_turno']);
  });

  it('pasa si el turno quedó cancelado por la clienta, y falla si sigue pendiente', () => {
    const turno = (estado: EvalAppointmentState['estado']) =>
      appointment({ clave: 'martes', inicio: '2026-10-13 17:00', estado });

    expect(check('cancelar_confirmado', withState({ turnos: [turno('CANCELLED_BY_CUSTOMER')] }))).toBeNull();
    expect(check('cancelar_confirmado', withState({ turnos: [turno('PENDING_DEPOSIT')] }))).toContain(
      'quedó PENDING_DEPOSIT y se esperaba CANCELLED_BY_CUSTOMER',
    );
  });
});

describe('cancelar_fuera_de_plazo', () => {
  const FRIDAY_EARLY = appointment({ clave: 'viernes', inicio: '2026-10-09 09:00' });

  it('el turno es mañana a primera hora: faltan menos de 24 horas desde el jueves 10:00', () => {
    expect(byName('cancelar_fuera_de_plazo').preparar?.turnos?.[0]).toMatchObject({
      clave: 'viernes',
      inicio: '2026-10-09 09:00',
    });
  });

  it('pasa si el turno no cambió y derivó por excepción con la conversación pausada', () => {
    expect(check('cancelar_fuera_de_plazo', withState({ turnos: [FRIDAY_EARLY], ...handedOff('policy_exception') }))).toBeNull();
  });

  it('falla si canceló el turno, o si no derivó', () => {
    const cancelled = { ...FRIDAY_EARLY, estado: 'CANCELLED_BY_CUSTOMER' as const };

    expect(check('cancelar_fuera_de_plazo', withState({ turnos: [cancelled], ...handedOff('policy_exception') }))).toContain(
      'CANCELLED_BY_CUSTOMER',
    );
    expect(check('cancelar_fuera_de_plazo', withState({ turnos: [FRIDAY_EARLY] }))).toContain('No derivó');
  });

  it('el agente explica la política y cuándo le responde una persona, con los textos del código', () => {
    const { espera } = byName('cancelar_fuera_de_plazo');

    expect(espera.herramientas).toEqual(['cancelar_turno']);
    expect(espera.menciona).toEqual(['24 horas', 'en este horario']);
  });
});

describe('reprogramar_ofrece', () => {
  const MARTES = appointment({ clave: 'martes', inicio: '2026-10-13 17:00' });

  it('pasa si ofrece solo horarios del miércoles 14/10 con Mica y el turno sigue en el martes', () => {
    const options = [offered(at('2026-10-14', '10:00')), offered(at('2026-10-14', '15:30'))];

    expect(check('reprogramar_ofrece', withState({ turnos: [MARTES] }, options))).toBeNull();
  });

  it('falla si ofrece un horario de otro día', () => {
    expect(check('reprogramar_ofrece', withState({ turnos: [MARTES] }, [offered(at('2026-10-15', '10:00'))]))).toContain(
      'Horario fuera de lo pedido',
    );
  });

  it('falla si ofrece un horario con otra profesional', () => {
    expect(
      check('reprogramar_ofrece', withState({ turnos: [MARTES] }, [offered(at('2026-10-14', '11:00'), 'Sofi')])),
    ).toContain('con Sofi');
  });

  it('falla si ya movió el turno sin que ella eligiera', () => {
    const moved = { ...MARTES, inicio: '2026-10-14 10:00' };

    expect(check('reprogramar_ofrece', withState({ turnos: [moved] }, [offered(at('2026-10-14', '10:00'))]))).toContain(
      'quedó el 2026-10-14 10:00',
    );
  });
});

describe('reprogramar_confirmado', () => {
  const moved = appointment({ clave: 'martes', inicio: '2026-10-14 15:30' });

  it('pasa si el turno quedó el miércoles 14/10 a las 15:30 y no derivó', () => {
    expect(check('reprogramar_confirmado', withState({ turnos: [moved] }))).toBeNull();
  });

  it('falla si el turno sigue en el martes, o si derivó', () => {
    const same = appointment({ clave: 'martes', inicio: '2026-10-13 17:00' });

    expect(check('reprogramar_confirmado', withState({ turnos: [same] }))).toContain('quedó el 2026-10-13 17:00');
    expect(check('reprogramar_confirmado', withState({ turnos: [moved], ...handedOff('policy_exception') }))).toContain(
      'No debía derivar',
    );
  });

  it('toca un horario del miércoles con Mica después de que el asistente se los ofreció', () => {
    const evalCase = byName('reprogramar_confirmado');

    expect(evalCase.mensajes).toEqual([
      {
        eleccion: { tipo: 'horario', servicio: SEMI, profesional: 'Mica', inicio: '2026-10-14 15:30' },
        titulo: 'mié 14/10 15:30',
      },
    ]);
    expect(evalCase.espera.herramientas).toEqual(['reprogramar_turno']);
  });
});

describe('reprogramar_sin_reprogramaciones', () => {
  const SAME = appointment({ clave: 'martes', inicio: '2026-10-13 17:00', estado: 'CONFIRMED' });

  it('el turno tiene la seña aprobada y ya se reprogramó una vez', () => {
    expect(byName('reprogramar_sin_reprogramaciones').preparar?.turnos?.[0]).toMatchObject({
      senaAprobada: true,
      reprogramadoDesde: ['2026-10-13 15:00'],
      inicio: '2026-10-13 17:00',
    });
  });

  it('pasa si el turno no cambió y derivó por excepción con la conversación pausada', () => {
    expect(
      check('reprogramar_sin_reprogramaciones', withState({ turnos: [SAME], ...handedOff('policy_exception') })),
    ).toBeNull();
  });

  it('falla si lo movió igual, o si no derivó', () => {
    const moved = { ...SAME, inicio: '2026-10-14 15:30' };

    expect(
      check('reprogramar_sin_reprogramaciones', withState({ turnos: [moved], ...handedOff('policy_exception') })),
    ).toContain('quedó el 2026-10-14 15:30');
    expect(check('reprogramar_sin_reprogramaciones', withState({ turnos: [SAME] }))).toContain('No derivó');
  });
});

describe('los casos de derivación', () => {
  it.each([
    ['pide_persona', 'customer_request'],
    ['queja', 'complaint'],
    ['salud_embarazo', 'sensitive_topic'],
    ['alergia', 'sensitive_topic'],
    ['imagen', 'unsupported_media'],
    ['consulta_previa', 'requires_consultation'],
    ['derivacion_fuera_de_horario', 'customer_request'],
  ] as const)('%s: espera derivar_a_persona con el motivo %s y la conversación pausada', (name, reason) => {
    expect(byName(name).espera.herramientas).toEqual(['derivar_a_persona']);
    expect(check(name, withState(handedOff(reason, 'Tema sensible: ver la conversación')))).toBeNull();
  });

  it.each([
    ['pide_persona', 'complaint'],
    ['queja', 'customer_request'],
    ['imagen', 'sensitive_topic'],
    ['consulta_previa', 'off_catalog'],
  ] as const)('%s: falla si derivó por otro motivo (%s)', (name, reason) => {
    expect(check(name, withState(handedOff(reason)))).toContain(`Derivó por ${reason}`);
  });

  it.each([
    'pide_persona',
    'queja',
    'salud_embarazo',
    'alergia',
    'imagen',
    'consulta_previa',
    'derivacion_fuera_de_horario',
  ])('%s: falla si no derivó', (name) => {
    expect(check(name, withState({}))).toContain('No derivó');
  });

  it('salud_embarazo y alergia: el resumen guardado no puede tener el dato de salud', () => {
    expect(check('salud_embarazo', withState(handedOff('sensitive_topic', 'Embarazada, consulta por lifting')))).toContain(
      'embaraz',
    );
    expect(check('alergia', withState(handedOff('sensitive_topic', 'Alergia al acrílico')))).toContain('alergi');
  });

  it('consulta_previa: tampoco se crea ningún turno', () => {
    const result = withState({ ...handedOff('requires_consultation'), turnos: [appointment()] });

    expect(check('consulta_previa', result)).toContain('no son los esperados');
  });

  it('imagen: la clienta manda una imagen con «quiero este diseño»', () => {
    expect(byName('imagen').mensajes).toEqual([{ imagen: 'quiero este diseño' }]);
  });

  it('derivacion_fuera_de_horario: es el jueves 8/10 a las 20:30 y el asistente dice el viernes 9/10 a las 9:00', () => {
    const evalCase = byName('derivacion_fuera_de_horario');

    expect(evalCase.ahora).toBe('2026-10-08 20:30');
    expect(evalCase.espera.menciona).toEqual(['9/10', '9:00']);
  });

  it('pide_persona: en horario de atención, el asistente dice "en este horario"', () => {
    expect(byName('pide_persona').espera.menciona).toEqual(['en este horario']);
  });
});
