import { describe, expect, it } from 'vitest';
import {
  availabilityInput,
  MAX_AVAILABILITY_RANGE_DAYS,
  periodOfDay,
  rescheduleAvailabilityInput,
} from '../../../../src/modules/conversation/tools/availability-input.js';

const SERVICE = '00000000-0000-4000-8000-000000000201';
const MICA = '00000000-0000-4000-8000-000000000101';

const parse = (overrides: Record<string, unknown>) =>
  availabilityInput.safeParse({ servicio_id: SERVICE, desde: '2026-10-05', hasta: '2026-10-05', ...overrides });

const messagesOf = (result: ReturnType<typeof parse>) =>
  result.success ? [] : result.error.issues.map((issue) => issue.message);

describe('availabilityInput: lo que puede pedir el modelo', () => {
  it('acepta lo mínimo: servicio y un rango de fechas locales', () => {
    const result = parse({});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ servicio_id: SERVICE, desde: '2026-10-05', hasta: '2026-10-05' });
  });

  it('acepta profesional, franja y "después de"', () => {
    const result = parse({ profesional_id: MICA, franja: 'tarde', despues_de: '2026-10-05T18:30:00.000Z' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ profesional_id: MICA, franja: 'tarde' });
  });

  it('el rango puede ser de hasta 7 días contando el primero y el último [S]', () => {
    expect(MAX_AVAILABILITY_RANGE_DAYS).toBe(7);
    expect(parse({ desde: '2026-10-05', hasta: '2026-10-11' }).success).toBe(true);
  });

  it('un rango de más de 7 días se rechaza con un mensaje que el modelo puede leer', () => {
    const result = parse({ desde: '2026-10-05', hasta: '2026-10-12' });

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toEqual(['El rango no puede superar los 7 días: pedí una semana por vez']);
  });

  it('el rango se cuenta bien al cruzar de mes y de año', () => {
    expect(parse({ desde: '2026-12-29', hasta: '2027-01-04' }).success).toBe(true);
    expect(parse({ desde: '2026-12-29', hasta: '2027-01-05' }).success).toBe(false);
  });

  it('"hasta" no puede ser anterior a "desde"', () => {
    const result = parse({ desde: '2026-10-06', hasta: '2026-10-05' });

    expect(messagesOf(result)).toEqual(['"hasta" no puede ser anterior a "desde"']);
  });

  it.each([
    ['con otro formato', '5/10/2026'],
    ['con la hora', '2026-10-05T10:00'],
    ['de un día que no existe', '2026-02-30'],
    ['de un mes que no existe', '2026-13-01'],
  ])('rechaza una fecha %s', (_description, date) => {
    expect(parse({ desde: date, hasta: date }).success).toBe(false);
  });

  it('rechaza un servicio o una profesional que no son ids', () => {
    expect(parse({ servicio_id: 'semi' }).success).toBe(false);
    expect(parse({ profesional_id: 'mica' }).success).toBe(false);
  });

  it('rechaza una franja que no existe', () => {
    expect(parse({ franja: 'madrugada' }).success).toBe(false);
  });

  it('rechaza un "después de" que no es un instante en UTC', () => {
    expect(parse({ despues_de: 'mañana' }).success).toBe(false);
    expect(parse({ despues_de: '2026-10-05' }).success).toBe(false);
  });

  it('el negocio y la clienta no son parte de la entrada: lo que sobre se descarta', () => {
    const result = parse({ tenant_id: 'otro', customer_id: 'otra' });

    expect(result.data).not.toHaveProperty('tenant_id');
    expect(result.data).not.toHaveProperty('customer_id');
  });
});

describe('availabilityInput: reservar siempre lleva el servicio (decisión 28)', () => {
  const APPOINTMENT = '00000000-0000-4000-8000-000000000301';

  it('sin servicio_id no hay qué consultar: el esquema lo exige', () => {
    const result = availabilityInput.safeParse({ desde: '2026-10-05', hasta: '2026-10-05' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['servicio_id']);
  });

  it('un turno_id no cambia lo que hace la herramienta: se descarta y el servicio sigue siendo obligatorio', () => {
    const withService = parse({ turno_id: APPOINTMENT });
    const withoutService = availabilityInput.safeParse({ turno_id: APPOINTMENT, desde: '2026-10-05', hasta: '2026-10-05' });

    expect(withService.data).not.toHaveProperty('turno_id');
    expect(withoutService.success).toBe(false);
  });
});

describe('periodOfDay: franjas [S] por hora local de inicio', () => {
  const minutes = (hour: number, minute = 0) => hour * 60 + minute;

  it('mañana es antes de las 13:00', () => {
    expect(periodOfDay(minutes(0))).toBe('manana');
    expect(periodOfDay(minutes(9))).toBe('manana');
    expect(periodOfDay(minutes(12, 59))).toBe('manana');
  });

  it('tarde es de 13:00 a 16:59', () => {
    expect(periodOfDay(minutes(13))).toBe('tarde');
    expect(periodOfDay(minutes(16, 59))).toBe('tarde');
  });

  it('noche es desde las 17:00', () => {
    expect(periodOfDay(minutes(17))).toBe('noche');
    expect(periodOfDay(minutes(23, 45))).toBe('noche');
  });
});

describe('rescheduleAvailabilityInput: los horarios para mover un turno (decisión 28)', () => {
  const APPOINTMENT = '00000000-0000-4000-8000-000000000301';
  const parseReschedule = (overrides: Record<string, unknown>) =>
    rescheduleAvailabilityInput.safeParse({ turno_id: APPOINTMENT, desde: '2026-10-05', hasta: '2026-10-05', ...overrides });
  const rescheduleMessages = (result: ReturnType<typeof parseReschedule>) =>
    result.success ? [] : result.error.issues.map((issue) => issue.message);

  it('acepta lo mínimo: el turno y un rango de fechas, y deja el id del turno sin prefijo', () => {
    const result = parseReschedule({});

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ turno_id: APPOINTMENT, desde: '2026-10-05', hasta: '2026-10-05' });
  });

  it('acepta el turno con el prefijo turno: o el uuid solo, tal cual lo ve el modelo', () => {
    expect(parseReschedule({ turno_id: `turno:${APPOINTMENT}` }).data?.turno_id).toBe(APPOINTMENT);
    expect(parseReschedule({ turno_id: APPOINTMENT }).data?.turno_id).toBe(APPOINTMENT);
  });

  it('el turno es obligatorio', () => {
    const result = rescheduleAvailabilityInput.safeParse({ desde: '2026-10-05', hasta: '2026-10-05' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['turno_id']);
  });

  it.each([
    ['un texto cualquiera', 'el del martes'],
    ['un id de cancelación', `cancelar:${APPOINTMENT}`],
    ['un horario', `reprogramar:${APPOINTMENT}:2026-10-09T18:30:00.000Z`],
    ['vacío', ''],
  ])('rechaza un turno_id que es %s, con un mensaje que el modelo puede corregir', (_description, turno_id) => {
    const result = parseReschedule({ turno_id });

    expect(result.success).toBe(false);
    expect(rescheduleMessages(result)).toEqual([
      'No es el id de un turno: usá el turnoId de listar_turnos_de_la_clienta, sin cambiarlo',
    ]);
  });

  it('acepta franja y "después de", y rechaza los que no existen', () => {
    expect(parseReschedule({ franja: 'tarde', despues_de: '2026-10-05T18:30:00.000Z' }).success).toBe(true);
    expect(parseReschedule({ franja: 'madrugada' }).success).toBe(false);
    expect(parseReschedule({ despues_de: 'mañana' }).success).toBe(false);
  });

  it('no tiene servicio ni profesional: salen del turno, y si el modelo los manda se descartan', () => {
    const result = parseReschedule({ servicio_id: SERVICE, profesional_id: MICA });

    expect(result.data).not.toHaveProperty('servicio_id');
    expect(result.data).not.toHaveProperty('profesional_id');
  });

  it('el rango tiene los mismos límites que al reservar: hasta 7 días y "hasta" no antes que "desde"', () => {
    expect(parseReschedule({ desde: '2026-10-05', hasta: '2026-10-11' }).success).toBe(true);
    expect(rescheduleMessages(parseReschedule({ desde: '2026-10-05', hasta: '2026-10-12' }))).toEqual([
      'El rango no puede superar los 7 días: pedí una semana por vez',
    ]);
    expect(rescheduleMessages(parseReschedule({ desde: '2026-10-06', hasta: '2026-10-05' }))).toEqual([
      '"hasta" no puede ser anterior a "desde"',
    ]);
  });
});
