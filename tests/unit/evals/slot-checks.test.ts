import { describe, expect, it } from 'vitest';
import { choiceIds } from '../../../src/modules/conversation/tools/choice-ids.js';
import type { ResolvedChoice } from '../../../src/modules/conversation/tools/choices.js';
import { localDateTimeToInstant } from '../../../src/shared/time-zone.js';
import type { EvalOption, EvalResult } from '../../evals/evaluate.js';
import {
  verifyCancelButtonOffered,
  verifyNoSlotsOnDay,
  verifyOffersFreeSlots,
  verifyOffersRescheduleSlots,
  verifySlotNotOffered,
  verifySlotOffered,
  verifySlotsOfProfessional,
  verifySlotsOnDayFrom,
  verifySlotsNotRepeatedInText,
} from '../../evals/slot-checks.js';

const MENDOZA = 'America/Argentina/Mendoza';
const at = (date: string, time: string) => localDateTimeToInstant(date, time, MENDOZA);

const SERVICE = '00000000-0000-4000-8000-000000000201';
const MICA = '00000000-0000-4000-8000-000000000101';

function resolved(start: Date, sigueLibre = true, professional = 'Mica'): ResolvedChoice {
  return {
    tipo: 'horario',
    servicioId: SERVICE,
    servicioNombre: 'Esmaltado semipermanente',
    profesionalId: MICA,
    profesionalNombre: professional,
    inicio: start.toISOString(),
    texto: 'texto',
    duracionMinutos: 60,
    sigueLibre,
  };
}

/** Un horario ofrecido, ya resuelto como lo hace la evaluación. */
function slot(start: Date, overrides: Partial<EvalOption> = {}): EvalOption {
  return {
    id: choiceIds.slot(SERVICE, MICA, start),
    titulo: 'vie 9/10 15:00',
    descripcion: 'con Mica',
    resuelta: resolved(start),
    ...overrides,
  };
}

const APPOINTMENT = '00000000-0000-4000-8000-0000000000aa';

/** Un horario para reprogramar un turno de la clienta, ya resuelto como lo hace la evaluación. */
function rescheduleSlot(start: Date, overrides: { sigueLibre?: boolean; profesional?: string } = {}): EvalOption {
  return {
    id: choiceIds.reschedule(APPOINTMENT, start),
    titulo: 'mié 14/10 15:30',
    descripcion: 'con Mica',
    resuelta: {
      tipo: 'reprogramar',
      turnoId: APPOINTMENT,
      servicioId: SERVICE,
      profesionalId: MICA,
      servicioNombre: 'Esmaltado semipermanente',
      profesionalNombre: overrides.profesional ?? 'Mica',
      turnoTexto: 'martes 13/10 17:00',
      estado: 'pendiente de seña',
      ocupaHorario: true,
      inicio: start.toISOString(),
      texto: 'texto',
      duracionMinutos: 60,
      sigueLibre: overrides.sigueLibre ?? true,
    },
  };
}

const seeMore: EvalOption = {
  id: choiceIds.more(SERVICE, null, at('2026-10-09', '16:30')),
  titulo: 'Ver otros horarios',
  descripcion: null,
};

function result(opciones: EvalOption[]): EvalResult {
  return {
    texto: 'Tengo estos horarios',
    tipo: 'list',
    opciones,
    herramientas: ['buscar_servicios', 'consultar_disponibilidad'],
    outcome: 'replied',
    tokens: { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 },
    latenciaMs: 1,
    estado: { turnos: [], derivaciones: [], pausada: false, nombreClienta: null },
  };
}

const FRIDAY_FROM_13 = { date: '2026-10-09', fromMinutes: 13 * 60 };

describe('verifySlotsOnDayFrom', () => {
  it('pasa si todos los horarios son del día, desde la hora pedida, y siguen libres', () => {
    const options = [slot(at('2026-10-09', '15:00')), slot(at('2026-10-09', '16:30')), seeMore];

    expect(verifySlotsOnDayFrom(result(options), FRIDAY_FROM_13, MENDOZA)).toBeNull();
  });

  it('el límite de la hora es inclusivo: las 13:00 en punto sirven', () => {
    expect(verifySlotsOnDayFrom(result([slot(at('2026-10-09', '13:00'))]), FRIDAY_FROM_13, MENDOZA)).toBeNull();
  });

  it('falla si no ofreció ningún horario, aunque haya otras opciones', () => {
    expect(verifySlotsOnDayFrom(result([seeMore]), FRIDAY_FROM_13, MENDOZA)).toBe(
      'No ofreció ningún horario',
    );
    expect(verifySlotsOnDayFrom(result([]), FRIDAY_FROM_13, MENDOZA)).toBe(
      'No ofreció ningún horario',
    );
  });

  it('falla si un horario es de la mañana, y dice cuál', () => {
    const reason = verifySlotsOnDayFrom(result([slot(at('2026-10-09', '15:00')), slot(at('2026-10-09', '11:00'))]), FRIDAY_FROM_13, MENDOZA);

    expect(reason).toBe('Horario fuera de lo pedido: 2026-10-09 11:00 (hora local); se pedía 2026-10-09 desde las 13:00');
  });

  it('falla si el horario es de otro día (el sábado)', () => {
    const reason = verifySlotsOnDayFrom(result([slot(at('2026-10-10', '09:00'))]), FRIDAY_FROM_13, MENDOZA);

    expect(reason).toContain('2026-10-10 09:00');
  });

  it('usa la hora local: las 22:00 UTC del viernes ya son sábado en Mendoza', () => {
    // 2026-10-10T01:00Z es el viernes 22:00 en Mendoza (UTC-3): es del día y pasa de las 13.
    const lateFriday = new Date('2026-10-10T01:00:00.000Z');

    expect(verifySlotsOnDayFrom(result([slot(lateFriday)]), FRIDAY_FROM_13, MENDOZA)).toBeNull();
    // y las 13:00 UTC del viernes son las 10:00 locales: temprano.
    const early = new Date('2026-10-09T13:00:00.000Z');
    expect(verifySlotsOnDayFrom(result([slot(early)]), FRIDAY_FROM_13, MENDOZA)).toContain('2026-10-09 10:00');
  });

  it('falla si un horario ya no está libre según resolveChoice', () => {
    const start = at('2026-10-09', '15:00');
    const taken = slot(start, { resuelta: resolved(start, false) });

    expect(verifySlotsOnDayFrom(result([taken]), FRIDAY_FROM_13, MENDOZA)).toBe(
      'El horario 2026-10-09 15:00 (hora local) no está libre según la base',
    );
  });

  it('falla si el horario no se pudo resolver', () => {
    const start = at('2026-10-09', '15:00');
    const unknown = slot(start, { resuelta: { tipo: 'desconocido' } });
    const missing = slot(start);
    delete missing.resuelta;

    expect(verifySlotsOnDayFrom(result([unknown]), FRIDAY_FROM_13, MENDOZA)).toContain('no está libre');
    expect(verifySlotsOnDayFrom(result([missing]), FRIDAY_FROM_13, MENDOZA)).toContain('no está libre');
  });
});

describe('los chequeos de horarios también leen los ids reprogramar: (decisión 28)', () => {
  const WEDNESDAY_FROM_0 = { date: '2026-10-14', fromMinutes: 0 };

  it('verifySlotsOnDayFrom cuenta los horarios para reprogramar, con su día y si siguen libres', () => {
    const options = [rescheduleSlot(at('2026-10-14', '10:00')), rescheduleSlot(at('2026-10-14', '15:30'))];

    expect(verifySlotsOnDayFrom(result(options), WEDNESDAY_FROM_0, MENDOZA)).toBeNull();
    expect(verifySlotsOnDayFrom(result([rescheduleSlot(at('2026-10-15', '10:00'))]), WEDNESDAY_FROM_0, MENDOZA)).toContain(
      '2026-10-15 10:00',
    );
    expect(
      verifySlotsOnDayFrom(result([rescheduleSlot(at('2026-10-14', '10:00'), { sigueLibre: false })]), WEDNESDAY_FROM_0, MENDOZA),
    ).toContain('no está libre');
  });

  it('verifySlotsOfProfessional lee la profesional del horario para reprogramar', () => {
    const options = [rescheduleSlot(at('2026-10-14', '10:00')), rescheduleSlot(at('2026-10-14', '11:00'), { profesional: 'Sofi' })];

    expect(verifySlotsOfProfessional(result(options), 'Mica', MENDOZA)).toContain('con Sofi');
    expect(verifySlotsOfProfessional(result(options.slice(0, 1)), 'Mica', MENDOZA)).toBeNull();
  });
});

describe('verifyOffersRescheduleSlots: ofrece horarios para mover el turno, nunca para reservar (decisión 28)', () => {
  it('pasa si hay al menos un horario y todos son reprogramar:, aunque haya «Ver otros horarios»', () => {
    const options = [rescheduleSlot(at('2026-10-14', '10:00')), rescheduleSlot(at('2026-10-14', '15:30')), seeMore];

    expect(verifyOffersRescheduleSlots(result(options), MENDOZA)).toBeNull();
  });

  it('falla si ofreció un horario para reservar (horario:), que es lo que hacía reservar un turno nuevo', () => {
    const options = [rescheduleSlot(at('2026-10-14', '10:00')), slot(at('2026-10-14', '15:30'))];

    expect(verifyOffersRescheduleSlots(result(options), MENDOZA)).toBe(
      'Ofreció un horario para reservar (horario:) en vez de uno para reprogramar: 2026-10-14 15:30 (hora local)',
    );
  });

  it('falla si no ofreció ningún horario', () => {
    expect(verifyOffersRescheduleSlots(result([seeMore]), MENDOZA)).toBe('No ofreció ningún horario');
  });

  it('falla si un horario no se pudo resolver como de un turno de la clienta', () => {
    const start = at('2026-10-14', '10:00');
    const unknown: EvalOption = { ...rescheduleSlot(start), resuelta: { tipo: 'desconocido' } };

    expect(verifyOffersRescheduleSlots(result([unknown]), MENDOZA)).toBe(
      'El horario para reprogramar 2026-10-14 10:00 (hora local) no es de un turno de la clienta',
    );
  });
});

describe('verifyNoSlotsOnDay', () => {
  it('pasa si no ofreció horarios ese día, aunque haya de otros', () => {
    const options = [slot(at('2026-10-13', '10:00')), slot(at('2026-10-13', '15:00')), seeMore];

    expect(verifyNoSlotsOnDay(result(options), '2026-10-12', MENDOZA)).toBeNull();
  });

  it('pasa si no ofreció ningún horario', () => {
    expect(verifyNoSlotsOnDay(result([]), '2026-10-12', MENDOZA)).toBeNull();
  });

  it('falla si ofreció un horario ese día, y dice cuál', () => {
    const reason = verifyNoSlotsOnDay(
      result([slot(at('2026-10-13', '10:00')), slot(at('2026-10-12', '15:00'))]),
      '2026-10-12',
      MENDOZA,
    );

    expect(reason).toBe('Ofreció un horario el 2026-10-12 (2026-10-12 15:00, hora local)');
  });

  it('usa la hora local: las 02:00 UTC del martes son el lunes 23:00 en Mendoza', () => {
    const mondayNight = new Date('2026-10-13T02:00:00.000Z');

    expect(verifyNoSlotsOnDay(result([slot(mondayNight)]), '2026-10-12', MENDOZA)).toContain('2026-10-12 23:00');
  });
});

describe('verifyOffersFreeSlots', () => {
  it('pasa si ofreció al menos un horario y todos siguen libres', () => {
    expect(verifyOffersFreeSlots(result([slot(at('2026-10-09', '15:00')), seeMore]), MENDOZA)).toBeNull();
  });

  it('no mira el día ni la hora: sirven de cualquier día', () => {
    expect(verifyOffersFreeSlots(result([slot(at('2026-10-20', '09:00'))]), MENDOZA)).toBeNull();
  });

  it('falla si no ofreció ningún horario', () => {
    expect(verifyOffersFreeSlots(result([seeMore]), MENDOZA)).toBe('No ofreció ningún horario');
  });

  it('falla si uno de los horarios ya no está libre', () => {
    const start = at('2026-10-09', '15:00');

    expect(verifyOffersFreeSlots(result([slot(start, { resuelta: resolved(start, false) })]), MENDOZA)).toBe(
      'El horario 2026-10-09 15:00 (hora local) no está libre según la base',
    );
  });
});

describe('verifySlotsOfProfessional', () => {
  const sofi = (start: Date) => slot(start, { resuelta: resolved(start, true, 'Sofi') });

  it('pasa si hay horarios y todos son de esa profesional', () => {
    expect(verifySlotsOfProfessional(result([sofi(at('2026-10-09', '15:00')), sofi(at('2026-10-09', '16:00'))]), 'Sofi', MENDOZA)).toBeNull();
  });

  it('falla si alguno es de otra profesional, y dice cuál', () => {
    const options = [sofi(at('2026-10-09', '15:00')), slot(at('2026-10-09', '16:00'))];

    expect(verifySlotsOfProfessional(result(options), 'Sofi', MENDOZA)).toBe(
      'Ofreció un horario con Mica (2026-10-09 16:00, hora local) y se pedía Sofi',
    );
  });

  it('falla si no ofreció ningún horario', () => {
    expect(verifySlotsOfProfessional(result([seeMore]), 'Sofi', MENDOZA)).toBe('No ofreció ningún horario');
  });
});

describe('verifySlotNotOffered', () => {
  const taken = { profesional: 'Mica', inicio: '2026-10-09 15:00' };

  it('pasa si no ofreció ese horario con esa profesional', () => {
    expect(verifySlotNotOffered(result([slot(at('2026-10-09', '16:30'))]), taken, MENDOZA)).toBeNull();
    expect(verifySlotNotOffered(result([]), taken, MENDOZA)).toBeNull();
  });

  it('a la misma hora con otra profesional sí se puede ofrecer', () => {
    const start = at('2026-10-09', '15:00');

    expect(verifySlotNotOffered(result([slot(start, { resuelta: resolved(start, true, 'Sofi') })]), taken, MENDOZA)).toBeNull();
  });

  it('falla si lo ofreció', () => {
    expect(verifySlotNotOffered(result([slot(at('2026-10-09', '15:00'))]), taken, MENDOZA)).toBe(
      'Ofreció el horario 2026-10-09 15:00 con Mica, que ya estaba ocupado',
    );
  });
});

describe('verifySlotOffered: ofreció justo la hora que preguntó la clienta (decisión 29)', () => {
  const asked = { inicio: '2026-10-09 17:30', para: 'reservar' } as const;

  it('pasa si ofreció ese horario para reservar y sigue libre según la base', () => {
    expect(verifySlotOffered(result([slot(at('2026-10-09', '17:30'))]), asked, MENDOZA)).toBeNull();
  });

  it('también cuando hay otros horarios ofrecidos', () => {
    const offered = [slot(at('2026-10-09', '15:00')), slot(at('2026-10-09', '17:30')), seeMore];

    expect(verifySlotOffered(result(offered), asked, MENDOZA)).toBeNull();
  });

  it('si se pide la profesional, tiene que ser esa', () => {
    const start = at('2026-10-09', '17:30');
    const withSofi = result([slot(start, { resuelta: resolved(start, true, 'Sofi') })]);

    expect(verifySlotOffered(result([slot(start)]), { ...asked, profesional: 'Mica' }, MENDOZA)).toBeNull();
    expect(verifySlotOffered(withSofi, { ...asked, profesional: 'Mica' }, MENDOZA)).toBe(
      'No ofreció el horario 2026-10-09 17:30 con Mica para reservar',
    );
    expect(verifySlotOffered(withSofi, asked, MENDOZA)).toBeNull();
  });

  it('falla si no ofreció nada, o si ofreció otra hora', () => {
    expect(verifySlotOffered(result([]), asked, MENDOZA)).toBe('No ofreció el horario 2026-10-09 17:30 para reservar');
    expect(verifySlotOffered(result([slot(at('2026-10-09', '17:15'))]), asked, MENDOZA)).toBe(
      'No ofreció el horario 2026-10-09 17:30 para reservar',
    );
    expect(verifySlotOffered(result([slot(at('2026-10-10', '17:30'))]), asked, MENDOZA)).toBe(
      'No ofreció el horario 2026-10-09 17:30 para reservar',
    );
  });

  it('falla si el horario ya no está libre según la base', () => {
    const start = at('2026-10-09', '17:30');
    const taken = result([slot(start, { resuelta: resolved(start, false) })]);

    expect(verifySlotOffered(taken, asked, MENDOZA)).toBe(
      'El horario 2026-10-09 17:30 (hora local) no está libre según la base',
    );
  });

  it('para reprogramar tiene que ser un id reprogramar:, no uno para reservar, y al revés', () => {
    const start = at('2026-10-14', '11:30');
    const move = { inicio: '2026-10-14 11:30', para: 'reprogramar' } as const;

    expect(verifySlotOffered(result([rescheduleSlot(start)]), move, MENDOZA)).toBeNull();
    expect(verifySlotOffered(result([slot(start)]), move, MENDOZA)).toBe(
      'No ofreció el horario 2026-10-14 11:30 para reprogramar',
    );
    expect(verifySlotOffered(result([rescheduleSlot(start)]), { ...move, para: 'reservar' }, MENDOZA)).toBe(
      'No ofreció el horario 2026-10-14 11:30 para reservar',
    );
  });

  it('un horario para reprogramar que no se pudo resolver contra el turno de la clienta no cuenta como libre', () => {
    const start = at('2026-10-14', '11:30');

    expect(
      verifySlotOffered(result([rescheduleSlot(start, { sigueLibre: false })]), { inicio: '2026-10-14 11:30', para: 'reprogramar' }, MENDOZA),
    ).toBe('El horario 2026-10-14 11:30 (hora local) no está libre según la base');
  });
});

describe('verifyCancelButtonOffered', () => {
  const appointmentId = '00000000-0000-4000-8000-0000000000aa';
  const cancelOption = (overrides: Partial<EvalOption> = {}): EvalOption => ({
    id: choiceIds.cancel(appointmentId),
    titulo: 'Sí, cancelar',
    descripcion: null,
    resuelta: {
      tipo: 'cancelar',
      turnoId: appointmentId,
      servicioId: SERVICE,
      profesionalId: MICA,
      servicioNombre: 'Esmaltado semipermanente',
      profesionalNombre: 'Mica',
      texto: 'martes 13/10 17:00',
      estado: 'pendiente de seña',
      ocupaHorario: true,
    },
    ...overrides,
  });

  it('pasa si ofreció el botón de cancelar de un turno de la clienta que sigue activo', () => {
    expect(verifyCancelButtonOffered(result([cancelOption()]))).toBeNull();
  });

  it('falla si no ofreció ningún botón de cancelar', () => {
    expect(verifyCancelButtonOffered(result([seeMore]))).toBe('No ofreció el botón «Sí, cancelar»');
  });

  it('falla si el id no es de un turno de la clienta (no se resuelve)', () => {
    expect(verifyCancelButtonOffered(result([cancelOption({ resuelta: { tipo: 'desconocido' } })]))).toBe(
      'El botón de cancelar no es de un turno de la clienta',
    );
  });

  it('falla si el turno ya no ocupa el horario', () => {
    const inactive = cancelOption();
    if (inactive.resuelta?.tipo === 'cancelar') inactive.resuelta = { ...inactive.resuelta, ocupaHorario: false };

    expect(verifyCancelButtonOffered(result([inactive]))).toBe('El botón de cancelar es de un turno que ya no está activo');
  });
});

describe('verifySlotsNotRepeatedInText: los horarios van en los botones, no repetidos en el texto (6.4)', () => {
  const offered = [slot(at('2026-10-09', '13:00')), slot(at('2026-10-09', '14:30')), slot(at('2026-10-09', '16:00'))];
  const withText = (texto: string): EvalResult => ({ ...result(offered), texto });

  it('falla si el texto repite los horarios ofrecidos (lo encontró la prueba manual con Meta)', () => {
    const repeated = withText(
      'Para el viernes a la tarde tenemos estos horarios: viernes 13:00 con Sofi, viernes 14:30 con Sofi y viernes 16:00 con Mica. ¿Cuál te queda mejor?',
    );
    expect(verifySlotsNotRepeatedInText(repeated, MENDOZA)).toMatch(/13:00.*14:30.*16:00/);
  });

  it('pasa si el texto invita a elegir sin repetirlos', () => {
    expect(verifySlotsNotRepeatedInText(withText('Para el viernes a la tarde tengo estos horarios. ¿Cuál te queda mejor?'), MENDOZA)).toBeNull();
  });

  it('pasa si nombra un solo horario (por ejemplo, el primero libre)', () => {
    expect(verifySlotsNotRepeatedInText(withText('El primero libre es a las 13:00. Elegí el que te quede mejor.'), MENDOZA)).toBeNull();
  });

  it('pasa si no ofreció horarios', () => {
    expect(verifySlotsNotRepeatedInText({ ...result([]), texto: 'viernes 13:00 y 14:30' }, MENDOZA)).toBeNull();
  });
});
