import { describe, expect, it } from 'vitest';
import {
  findAvailableSlots,
  occupiedRanges,
  pickFirstAvailable,
  type AvailabilityQuery,
  type ProfessionalSchedule,
  type Slot,
  type WeeklyBlock,
} from '../../../src/modules/scheduling/availability.js';
import { instantToLocal, localDateTimeToInstant } from '../../../src/shared/time-zone.js';

const MENDOZA = 'America/Argentina/Mendoza';

// Octubre de 2026: el 4 es domingo, el 5 lunes, el 12 lunes y feriado.
const at = (date: string, time: string) => localDateTimeToInstant(date, time, MENDOZA);
const range = (date: string, start: string, end: string) => ({
  start: at(date, start),
  end: at(date, end),
});
const wholeDay = (date: string, nextDate: string) => ({
  start: at(date, '00:00'),
  end: at(nextDate, '00:00'),
});

const weekly = (weekdays: number[], start: string, end: string): WeeklyBlock[] =>
  weekdays.map((weekday) => ({ weekday, start, end }));

// Mica: horario partido. Sofi: horario corrido.
const MICA_HOURS = [
  ...weekly([1, 2, 3, 4, 5], '09:00', '13:00'),
  ...weekly([1, 2, 3, 4, 5], '15:00', '20:00'),
  ...weekly([6], '09:00', '13:00'),
];
const SOFI_HOURS = weekly([2, 3, 4, 5, 6], '10:00', '18:00');

const mica = (overrides: Partial<ProfessionalSchedule> = {}): ProfessionalSchedule => ({
  id: 'mica',
  weeklyHours: MICA_HOURS,
  busy: [],
  ...overrides,
});
const sofi = (overrides: Partial<ProfessionalSchedule> = {}): ProfessionalSchedule => ({
  id: 'sofi',
  weeklyHours: SOFI_HOURS,
  busy: [],
  ...overrides,
});

/** Semipermanente: 60 minutos más 10 de margen. Por defecto busca el lunes 5. */
function query(overrides: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    now: at('2026-10-04', '09:00'),
    timeZone: MENDOZA,
    window: wholeDay('2026-10-05', '2026-10-06'),
    service: { durationMinutes: 60, bufferMinutes: 10 },
    professionals: [mica()],
    exceptions: [],
    holidays: [],
    worksOnHolidays: false,
    rules: { slotGranularityMinutes: 15, minBookingNoticeMinutes: 120, maxBookingAdvanceDays: 30 },
    ...overrides,
  };
}

/** Horarios de inicio en hora de Mendoza, opcionalmente de una sola profesional. */
function startTimes(slots: Slot[], professionalId?: string): string[] {
  return slots
    .filter((slot) => professionalId === undefined || slot.professionalId === professionalId)
    .map((slot) => instantToLocal(slot.start, MENDOZA).time);
}

/** "09:00" a "12:00" cada 15 minutos, ambos incluidos. */
function every15(from: string, to: string): string[] {
  const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const result: string[] = [];
  for (let minutes = toMinutes(from); minutes <= toMinutes(to); minutes += 15) {
    result.push(
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
    );
  }
  return result;
}

const MICA_FULL_MONDAY = [...every15('09:00', '12:00'), ...every15('15:00', '19:00')];

describe('findAvailableSlots: horario semanal', () => {
  it('devuelve cada turno con su inicio, su fin y hasta cuándo ocupa a la profesional', () => {
    const [first] = findAvailableSlots(query());

    expect(first).toEqual({
      professionalId: 'mica',
      start: at('2026-10-05', '09:00'),
      end: at('2026-10-05', '10:00'),
      occupiedUntil: at('2026-10-05', '10:10'),
    });
  });

  it('ofrece turnos en los dos bloques de un horario partido, cada 15 minutos', () => {
    expect(startTimes(findAvailableSlots(query()))).toEqual(MICA_FULL_MONDAY);
  });

  it('un turno no empieza en un bloque y termina en el siguiente', () => {
    const times = startTimes(findAvailableSlots(query()));

    expect(times).not.toContain('12:30');
    expect(times).not.toContain('14:30');
  });

  it('un servicio largo tiene su último turno antes en cada bloque', () => {
    const slots = findAvailableSlots(query({ service: { durationMinutes: 120, bufferMinutes: 15 } }));

    expect(startTimes(slots)).toEqual([...every15('09:00', '11:00'), ...every15('15:00', '18:00')]);
  });

  it('el margen de limpieza puede quedar después del cierre del bloque (decisión 1a)', () => {
    const slots = findAvailableSlots(query());

    expect(startTimes(slots)).toContain('12:00');
    expect(slots.find((slot) => slot.start.getTime() === at('2026-10-05', '12:00').getTime()))
      .toMatchObject({ occupiedUntil: at('2026-10-05', '13:10') });
  });

  it('un día sin horario no tiene turnos', () => {
    expect(findAvailableSlots(query({ window: wholeDay('2026-10-04', '2026-10-05') }))).toEqual([]);
  });

  it('los inicios se alinean al reloj aunque el bloque empiece en un minuto raro', () => {
    const slots = findAvailableSlots(
      query({ professionals: [mica({ weeklyHours: weekly([1], '09:10', '11:00') })] }),
    );

    expect(startTimes(slots)).toEqual(['09:15', '09:30', '09:45', '10:00']);
  });
});

describe('findAvailableSlots: lo que ya está ocupado', () => {
  it('no ofrece horarios que se superponen con un turno existente ni con su margen', () => {
    const slots = findAvailableSlots(
      query({ professionals: [mica({ busy: [range('2026-10-05', '10:00', '11:10')] })] }),
    );

    // 09:00 terminaría a las 10:00 y su limpieza pisaría el turno de las 10:00.
    expect(startTimes(slots)).toEqual([...every15('11:15', '12:00'), ...every15('15:00', '19:00')]);
  });

  it('el margen del turno nuevo tampoco puede pisar el turno siguiente', () => {
    const slots = findAvailableSlots(
      query({ professionals: [mica({ busy: [range('2026-10-05', '11:00', '12:10')] })] }),
    );
    const times = startTimes(slots);

    expect(times).toContain('09:45');
    expect(times).not.toContain('10:00');
  });

  it('respeta los eventos ocupados del Google Calendar de la profesional', () => {
    const slots = findAvailableSlots(
      query({ professionals: [mica({ busy: [range('2026-10-05', '16:00', '17:00')] })] }),
    );
    const afternoon = startTimes(slots).filter((time) => time >= '15:00');

    expect(afternoon).toEqual(every15('17:00', '19:00'));
  });
});

describe('occupiedRanges: qué turnos ocupan el horario', () => {
  const now = at('2026-10-05', '09:00');
  const timeRange = range('2026-10-05', '10:00', '11:10');

  it.each([
    ['confirmado', 'CONFIRMED', null, true],
    ['con la seña en verificación, aunque haya pasado su vencimiento', 'DEPOSIT_REVIEW', at('2026-10-05', '08:00'), true],
    ['con la seña pendiente y vigente', 'PENDING_DEPOSIT', at('2026-10-05', '09:30'), true],
    ['con la seña pendiente ya vencida', 'PENDING_DEPOSIT', at('2026-10-05', '09:00'), false],
    ['cancelado', 'CANCELLED_BY_CUSTOMER', null, false],
    ['expirado', 'EXPIRED', null, false],
    ['completado', 'COMPLETED', null, false],
  ] as const)('un turno %s → ocupa: %s', (_case, status, depositExpiresAt, occupies) => {
    const result = occupiedRanges([{ status, timeRange, depositExpiresAt }], now);

    expect(result).toEqual(occupies ? [timeRange] : []);
  });
});

describe('findAvailableSlots: excepciones y feriados', () => {
  it('una profesional de vacaciones no tiene turnos', () => {
    const slots = findAvailableSlots(
      query({
        exceptions: [
          { professionalId: 'mica', kind: 'closed', range: wholeDay('2026-10-05', '2026-10-06') },
        ],
      }),
    );

    expect(slots).toEqual([]);
  });

  it('un cierre de todo el negocio afecta a todas las profesionales', () => {
    const slots = findAvailableSlots(
      query({
        window: wholeDay('2026-10-06', '2026-10-07'),
        professionals: [mica(), sofi()],
        exceptions: [
          { professionalId: null, kind: 'closed', range: range('2026-10-06', '12:00', '20:00') },
        ],
      }),
    );

    expect(startTimes(slots, 'mica')).toEqual(every15('09:00', '11:00'));
    expect(startTimes(slots, 'sofi')).toEqual(every15('10:00', '11:00'));
  });

  it('el horario especial de una profesional reemplaza su horario de ese día', () => {
    const slots = findAvailableSlots(
      query({
        window: wholeDay('2026-10-11', '2026-10-12'),
        exceptions: [
          { professionalId: 'mica', kind: 'special_hours', range: range('2026-10-11', '10:00', '14:00') },
        ],
      }),
    );

    expect(startTimes(slots)).toEqual(every15('10:00', '13:00'));
  });

  it('el horario especial del negocio recorta el horario de cada profesional', () => {
    const slots = findAvailableSlots(
      query({
        window: wholeDay('2026-10-07', '2026-10-08'),
        professionals: [mica(), sofi()],
        exceptions: [
          { professionalId: null, kind: 'special_hours', range: range('2026-10-07', '09:00', '12:00') },
        ],
      }),
    );

    expect(startTimes(slots, 'mica')).toEqual(every15('09:00', '11:00'));
    expect(startTimes(slots, 'sofi')).toEqual(every15('10:00', '11:00'));
  });

  it('un feriado cierra el negocio si no trabaja feriados', () => {
    const slots = findAvailableSlots(
      query({ window: wholeDay('2026-10-12', '2026-10-13'), holidays: ['2026-10-12'] }),
    );

    expect(slots).toEqual([]);
  });

  it('un negocio que trabaja feriados atiende con su horario normal', () => {
    const slots = findAvailableSlots(
      query({
        window: wholeDay('2026-10-12', '2026-10-13'),
        holidays: ['2026-10-12'],
        worksOnHolidays: true,
      }),
    );

    expect(startTimes(slots)).toEqual(MICA_FULL_MONDAY);
  });

  it('un horario especial del negocio abre un feriado puntual', () => {
    const slots = findAvailableSlots(
      query({
        window: wholeDay('2026-10-12', '2026-10-13'),
        holidays: ['2026-10-12'],
        exceptions: [
          { professionalId: null, kind: 'special_hours', range: range('2026-10-12', '09:00', '13:00') },
        ],
      }),
    );

    expect(startTimes(slots)).toEqual(every15('09:00', '12:00'));
  });
});

describe('findAvailableSlots: anticipación', () => {
  it('no ofrece turnos antes de la anticipación mínima', () => {
    const slots = findAvailableSlots(query({ now: at('2026-10-05', '09:40') }));

    // 09:40 + 2 horas = 11:40: el primer inicio posible es 11:45.
    expect(startTimes(slots)).toEqual([...every15('11:45', '12:00'), ...every15('15:00', '19:00')]);
  });

  it('no ofrece turnos más allá de la anticipación máxima', () => {
    const now = at('2026-10-05', '09:00');
    const slots = findAvailableSlots(
      query({ now, window: { start: now, end: at('2026-11-30', '00:00') } }),
    );
    const last = slots.at(-1);

    expect(last).toBeDefined();
    expect(last?.start.getTime()).toBeLessThanOrEqual(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(instantToLocal(last?.start ?? now, MENDOZA).date).toBe('2026-11-04');
  });

  it('solo busca dentro de la ventana pedida', () => {
    const slots = findAvailableSlots(query({ window: range('2026-10-05', '10:00', '11:00') }));

    expect(startTimes(slots)).toEqual(every15('10:00', '10:45'));
  });
});

describe('findAvailableSlots: varias profesionales y cambio de día', () => {
  it('junta los turnos de varias profesionales ordenados por horario', () => {
    const slots = findAvailableSlots(
      query({ window: range('2026-10-06', '09:00', '10:30'), professionals: [mica(), sofi()] }),
    );

    expect(slots.map((slot) => `${instantToLocal(slot.start, MENDOZA).time} ${slot.professionalId}`))
      .toEqual([
        '09:00 mica',
        '09:15 mica',
        '09:30 mica',
        '09:45 mica',
        '10:00 mica',
        '10:00 sofi',
        '10:15 mica',
        '10:15 sofi',
      ]);
  });

  it('usa la duración propia de cada profesional para el mismo servicio', () => {
    const slots = findAvailableSlots(
      query({
        window: wholeDay('2026-10-06', '2026-10-07'),
        professionals: [mica(), sofi({ durationOverrideMinutes: 75 })],
      }),
    );
    const lastSofi = slots.filter((slot) => slot.professionalId === 'sofi').at(-1);

    expect(instantToLocal(lastSofi?.start ?? new Date(0), MENDOZA).time).toBe('16:45');
    expect(lastSofi?.end).toEqual(at('2026-10-06', '18:00'));
    expect(startTimes(slots, 'mica')).toContain('19:00');
  });

  it('no pierde turnos cuando en UTC ya es el día siguiente', () => {
    // 21:00 a 23:30 en Mendoza es 00:00 a 02:30 del martes en UTC.
    const slots = findAvailableSlots(
      query({ professionals: [mica({ weeklyHours: weekly([1], '21:00', '23:30') })] }),
    );

    expect(startTimes(slots)).toEqual(every15('21:00', '22:30'));
    expect(slots.every((slot) => instantToLocal(slot.start, MENDOZA).date === '2026-10-05')).toBe(true);
  });

  it('busca en varios días seguidos', () => {
    const slots = findAvailableSlots(
      query({ window: { start: at('2026-10-05', '18:00'), end: at('2026-10-06', '10:00') } }),
    );

    expect(
      slots.map((slot) => {
        const local = instantToLocal(slot.start, MENDOZA);
        return `${local.date} ${local.time}`;
      }),
    ).toEqual([
      ...every15('18:00', '19:00').map((time) => `2026-10-05 ${time}`),
      ...every15('09:00', '09:45').map((time) => `2026-10-06 ${time}`),
    ]);
  });

  it('rechaza una configuración inválida', () => {
    expect(() =>
      findAvailableSlots(
        query({ rules: { slotGranularityMinutes: 0, minBookingNoticeMinutes: 120, maxBookingAdvanceDays: 30 } }),
      ),
    ).toThrow(/granularidad/i);
  });
});

describe('pickFirstAvailable: la clienta no eligió profesional', () => {
  const slot = (time: string, professionalId: string): Slot => ({
    professionalId,
    start: at('2026-10-06', time),
    end: at('2026-10-06', time),
    occupiedUntil: at('2026-10-06', time),
  });
  const slots = [slot('10:00', 'mica'), slot('10:00', 'sofi'), slot('10:15', 'sofi')];

  it('ofrece cada horario una sola vez, con la primera profesional disponible', () => {
    expect(pickFirstAvailable(slots, { professionalOrder: ['mica', 'sofi'] })).toEqual([
      slot('10:00', 'mica'),
      slot('10:15', 'sofi'),
    ]);
  });

  it('si la profesional preferida de la clienta está libre, va primero', () => {
    expect(
      pickFirstAvailable(slots, { professionalOrder: ['mica', 'sofi'], preferredProfessionalId: 'sofi' }),
    ).toEqual([slot('10:00', 'sofi'), slot('10:15', 'sofi')]);
  });
});
