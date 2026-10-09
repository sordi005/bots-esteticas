import { describe, expect, it } from 'vitest';
import { choiceIds, parseAppointmentRef, parseChoiceId } from '../../../../src/modules/conversation/tools/choice-ids.js';

const SERVICE = '00000000-0000-4000-8000-000000000201';
const MICA = '00000000-0000-4000-8000-000000000101';
const APPOINTMENT = '00000000-0000-4000-8000-000000000301';
const START = new Date('2026-10-09T18:30:00.000Z');

describe('choiceIds: los ids de las opciones que se ofrecen (5.3)', () => {
  it('arma los formatos documentados', () => {
    expect(choiceIds.service(SERVICE)).toBe(`servicio:${SERVICE}`);
    expect(choiceIds.slot(SERVICE, MICA, START)).toBe(`horario:${SERVICE}:${MICA}:2026-10-09T18:30:00.000Z`);
    expect(choiceIds.more(SERVICE, MICA, START)).toBe(`mas:${SERVICE}:${MICA}:2026-10-09T18:30:00.000Z`);
    expect(choiceIds.more(SERVICE, null, START)).toBe(`mas:${SERVICE}:-:2026-10-09T18:30:00.000Z`);
    expect(choiceIds.appointment(APPOINTMENT)).toBe(`turno:${APPOINTMENT}`);
    expect(choiceIds.cancel(APPOINTMENT)).toBe(`cancelar:${APPOINTMENT}`);
  });

  it('el id más largo entra en el límite de una fila de lista (200 caracteres)', () => {
    expect(choiceIds.slot(SERVICE, MICA, START).length).toBeLessThanOrEqual(200);
  });
});

describe('parseChoiceId: lee un id sin confiar en él', () => {
  it('lee un servicio', () => {
    expect(parseChoiceId(`servicio:${SERVICE}`)).toEqual({ kind: 'service', serviceId: SERVICE });
  });

  it('lee un horario, con su inicio como fecha', () => {
    expect(parseChoiceId(choiceIds.slot(SERVICE, MICA, START))).toEqual({
      kind: 'slot',
      serviceId: SERVICE,
      professionalId: MICA,
      start: START,
    });
  });

  it('lee "ver otros", con y sin profesional', () => {
    expect(parseChoiceId(choiceIds.more(SERVICE, MICA, START))).toEqual({
      kind: 'more',
      serviceId: SERVICE,
      professionalId: MICA,
      after: START,
    });
    expect(parseChoiceId(choiceIds.more(SERVICE, null, START))).toEqual({
      kind: 'more',
      serviceId: SERVICE,
      professionalId: null,
      after: START,
    });
  });

  it('lee un turno elegido y la confirmación de cancelarlo', () => {
    expect(parseChoiceId(`turno:${APPOINTMENT}`)).toEqual({ kind: 'appointment', appointmentId: APPOINTMENT });
    expect(parseChoiceId(`cancelar:${APPOINTMENT}`)).toEqual({ kind: 'cancel', appointmentId: APPOINTMENT });
  });

  it.each([
    ['vacío', ''],
    ['un texto cualquiera', 'hola'],
    ['un prefijo que no existe', `cita:${SERVICE}`],
    ['un servicio sin uuid', 'servicio:semi'],
    ['un servicio con algo de más', `servicio:${SERVICE}:extra`],
    ['un horario sin profesional', `horario:${SERVICE}:2026-10-09T18:30:00.000Z`],
    ['un horario con la profesional "-"', `horario:${SERVICE}:-:2026-10-09T18:30:00.000Z`],
    ['un horario con un uuid mal formado', `horario:${SERVICE}:123:2026-10-09T18:30:00.000Z`],
    ['una fecha que no existe', `horario:${SERVICE}:${MICA}:2026-13-45T18:30:00.000Z`],
    ['una fecha con otra zona', `horario:${SERVICE}:${MICA}:2026-10-09T15:30:00.000-03:00`],
    ['una fecha sin milisegundos', `horario:${SERVICE}:${MICA}:2026-10-09T18:30:00Z`],
    ['un "ver otros" sin fecha', `mas:${SERVICE}:-:`],
    ['un turno sin uuid', 'turno:el-del-martes'],
    ['un turno con algo de más', `turno:${APPOINTMENT}:extra`],
    ['una cancelación sin uuid', 'cancelar:'],
    ['una cancelación con mayúsculas en el prefijo', `Cancelar:${APPOINTMENT}`],
  ])('rechaza %s', (_description, id) => {
    expect(parseChoiceId(id)).toBeNull();
  });
});

describe('parseAppointmentRef: el turno que nombra el modelo, con o sin el prefijo', () => {
  it('acepta turno:<uuid> y el uuid solo', () => {
    expect(parseAppointmentRef(`turno:${APPOINTMENT}`)).toBe(APPOINTMENT);
    expect(parseAppointmentRef(APPOINTMENT)).toBe(APPOINTMENT);
  });

  it.each([
    ['vacío', ''],
    ['un texto cualquiera', 'el del martes'],
    ['el id de una confirmación', `cancelar:${APPOINTMENT}`],
    ['el id de un horario', `horario:${SERVICE}:${APPOINTMENT}:2026-10-09T18:30:00.000Z`],
    ['un uuid con algo de más', `${APPOINTMENT} `],
  ])('rechaza %s', (_description, ref) => {
    expect(parseAppointmentRef(ref)).toBeNull();
  });
});
