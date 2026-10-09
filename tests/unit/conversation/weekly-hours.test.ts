import { describe, expect, it } from 'vitest';
import {
  describeTeamHours,
  describeWeeklyHours,
} from '../../../src/modules/conversation/weekly-hours.js';
import type { WeeklyBlock } from '../../../src/modules/scheduling/availability.js';

const blocks = (weekdays: number[], start: string, end: string): WeeklyBlock[] =>
  weekdays.map((weekday) => ({ weekday, start, end }));

const MICA = [
  ...blocks([1, 2, 3, 4, 5], '09:00', '13:00'),
  ...blocks([1, 2, 3, 4, 5], '15:00', '20:00'),
  ...blocks([6], '09:00', '13:00'),
];
const SOFI = blocks([2, 3, 4, 5, 6], '10:00', '18:00');

describe('describeWeeklyHours: el horario semanal escrito para la clienta', () => {
  it('junta los días seguidos con el mismo horario y separa los bloques con "y"', () => {
    expect(describeWeeklyHours(MICA)).toBe(
      'lunes a viernes de 9 a 13 y de 15 a 20; sábados de 9 a 13',
    );
  });

  it('un horario corrido de martes a sábado', () => {
    expect(describeWeeklyHours(SOFI)).toBe('martes a sábado de 10 a 18');
  });

  it('un día suelto va en plural: "sábados", "domingos"', () => {
    expect(describeWeeklyHours(blocks([6], '09:00', '13:00'))).toBe('sábados de 9 a 13');
    expect(describeWeeklyHours(blocks([7], '10:00', '14:00'))).toBe('domingos de 10 a 14');
  });

  it('dos días seguidos van con "y", tres o más con "a"', () => {
    expect(describeWeeklyHours(blocks([1, 2], '09:00', '13:00'))).toBe('lunes y martes de 9 a 13');
    expect(describeWeeklyHours(blocks([1, 2, 3], '09:00', '13:00'))).toBe('lunes a miércoles de 9 a 13');
  });

  it('los días con distinto horario van separados', () => {
    const hours = [...blocks([1], '09:00', '13:00'), ...blocks([2], '10:00', '14:00')];
    expect(describeWeeklyHours(hours)).toBe('lunes de 9 a 13; martes de 10 a 14');
  });

  it('un día salteado corta la serie', () => {
    expect(describeWeeklyHours(blocks([1, 3], '09:00', '13:00'))).toBe(
      'lunes de 9 a 13; miércoles de 9 a 13',
    );
  });

  it('las horas con minutos los muestran y las en punto no', () => {
    expect(describeWeeklyHours(blocks([1], '09:30', '13:15'))).toBe('lunes de 9:30 a 13:15');
  });

  it('acepta las horas como las devuelve la base ("09:00:00") y bloques fuera de orden', () => {
    const hours = [
      { weekday: 1, start: '15:00:00', end: '20:00:00' },
      { weekday: 1, start: '09:00:00', end: '13:00:00' },
    ];
    expect(describeWeeklyHours(hours)).toBe('lunes de 9 a 13 y de 15 a 20');
  });

  it('tres bloques en un día: comas y una "y" al final', () => {
    const hours = [
      { weekday: 3, start: '09:00', end: '12:00' },
      { weekday: 3, start: '14:00', end: '16:00' },
      { weekday: 3, start: '17:00', end: '20:00' },
    ];
    expect(describeWeeklyHours(hours)).toBe('miércoles de 9 a 12, de 14 a 16 y de 17 a 20');
  });

  it('sin bloques no hay nada que decir', () => {
    expect(describeWeeklyHours([])).toBe('');
  });
});

describe('describeTeamHours: el horario de todas las profesionales', () => {
  it('si todas atienden en el mismo horario, lo dice una sola vez', () => {
    const text = describeTeamHours([
      { name: 'Mica', blocks: SOFI },
      { name: 'Sofi', blocks: SOFI },
    ]);
    expect(text).toBe('martes a sábado de 10 a 18');
  });

  it('si difieren, va una línea por profesional', () => {
    const text = describeTeamHours([
      { name: 'Mica', blocks: MICA },
      { name: 'Sofi', blocks: SOFI },
    ]);
    expect(text).toBe(
      'Mica: lunes a viernes de 9 a 13 y de 15 a 20; sábados de 9 a 13\nSofi: martes a sábado de 10 a 18',
    );
  });

  it('una sola profesional: solo el horario, sin su nombre', () => {
    expect(describeTeamHours([{ name: 'Mica', blocks: MICA }])).toBe(
      'lunes a viernes de 9 a 13 y de 15 a 20; sábados de 9 a 13',
    );
  });

  it('deja afuera a las que no tienen horario cargado', () => {
    const text = describeTeamHours([
      { name: 'Mica', blocks: MICA },
      { name: 'Sofi', blocks: [] },
    ]);
    expect(text).toBe('lunes a viernes de 9 a 13 y de 15 a 20; sábados de 9 a 13');
  });

  it('sin profesionales con horario devuelve vacío', () => {
    expect(describeTeamHours([])).toBe('');
    expect(describeTeamHours([{ name: 'Mica', blocks: [] }])).toBe('');
  });
});
