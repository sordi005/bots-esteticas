import { describe, expect, it } from 'vitest';
import { choiceIds } from '../../../src/modules/conversation/tools/choice-ids.js';
import type { ResolvedChoice } from '../../../src/modules/conversation/tools/choices.js';
import { localDateTimeToInstant } from '../../../src/shared/time-zone.js';
import type { EvalOption, EvalResult } from '../../evals/evaluate.js';
import { verifyNoSlotsOnDay, verifySlotsOnDayFrom } from '../../evals/slot-checks.js';

const MENDOZA = 'America/Argentina/Mendoza';
const at = (date: string, time: string) => localDateTimeToInstant(date, time, MENDOZA);

const SERVICE = '00000000-0000-4000-8000-000000000201';
const MICA = '00000000-0000-4000-8000-000000000101';

function resolved(start: Date, sigueLibre = true): ResolvedChoice {
  return {
    tipo: 'horario',
    servicioId: SERVICE,
    servicioNombre: 'Esmaltado semipermanente',
    profesionalId: MICA,
    profesionalNombre: 'Mica',
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
