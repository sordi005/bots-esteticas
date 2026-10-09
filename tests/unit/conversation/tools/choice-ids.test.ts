import { describe, expect, it } from 'vitest';
import { choiceIds, parseChoiceId } from '../../../../src/modules/conversation/tools/choice-ids.js';

const SERVICE = '00000000-0000-4000-8000-000000000201';
const MICA = '00000000-0000-4000-8000-000000000101';
const START = new Date('2026-10-09T18:30:00.000Z');

describe('choiceIds: los ids de las opciones que se ofrecen (5.3)', () => {
  it('arma los tres formatos documentados', () => {
    expect(choiceIds.service(SERVICE)).toBe(`servicio:${SERVICE}`);
    expect(choiceIds.slot(SERVICE, MICA, START)).toBe(`horario:${SERVICE}:${MICA}:2026-10-09T18:30:00.000Z`);
    expect(choiceIds.more(SERVICE, MICA, START)).toBe(`mas:${SERVICE}:${MICA}:2026-10-09T18:30:00.000Z`);
    expect(choiceIds.more(SERVICE, null, START)).toBe(`mas:${SERVICE}:-:2026-10-09T18:30:00.000Z`);
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
  ])('rechaza %s', (_description, id) => {
    expect(parseChoiceId(id)).toBeNull();
  });
});
