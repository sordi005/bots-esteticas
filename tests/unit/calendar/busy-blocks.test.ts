import { describe, expect, it } from 'vitest';
import { busyBlocks } from '../../../src/modules/calendar/busy-blocks.js';
import type { CalendarEvent } from '../../../src/modules/calendar/client.js';
import { localDateTimeToInstant } from '../../../src/shared/time-zone.js';

const MENDOZA = 'America/Argentina/Mendoza';
const at = (date: string, time: string) => localDateTimeToInstant(date, time, MENDOZA);

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evento1',
    cancelled: false,
    transparent: false,
    declined: false,
    appointmentId: null,
    start: { at: at('2026-11-05', '10:00') },
    end: { at: at('2026-11-05', '11:00') },
    ...overrides,
  };
}

describe('busyBlocks: qué eventos del calendario bloquean horarios (4.2, D5)', () => {
  it('un evento "Ocupado" bloquea su horario', () => {
    expect(busyBlocks([event()], MENDOZA)).toEqual([{ start: at('2026-11-05', '10:00'), end: at('2026-11-05', '11:00') }]);
  });

  it.each<[string, Partial<CalendarEvent>]>([
    ['"Disponible"', { transparent: true }],
    ['cancelado', { cancelled: true }],
    ['una invitación que rechazó', { declined: true }],
    ['el evento de un turno nuestro', { appointmentId: 'cffcb42e-ef8b-4a0e-9f9b-9b555253f017' }],
  ])('no bloquea: %s', (_case, overrides) => {
    expect(busyBlocks([event(overrides)], MENDOZA)).toEqual([]);
  });

  it('uno de todo el día bloquea el día entero en la zona horaria del negocio', () => {
    const allDay = event({ start: { date: '2026-11-05' }, end: { date: '2026-11-06' } });

    expect(busyBlocks([allDay], MENDOZA)).toEqual([{ start: at('2026-11-05', '00:00'), end: at('2026-11-06', '00:00') }]);
  });

  it('unas vacaciones de varios días bloquean hasta el fin, que es exclusivo', () => {
    const vacation = event({ start: { date: '2026-11-09' }, end: { date: '2026-11-14' } });

    expect(busyBlocks([vacation], MENDOZA)).toEqual([{ start: at('2026-11-09', '00:00'), end: at('2026-11-14', '00:00') }]);
  });

  it('uno de todo el día marcado "Disponible" (como lo crea Google) no bloquea', () => {
    const birthday = event({ start: { date: '2026-11-05' }, end: { date: '2026-11-06' }, transparent: true });

    expect(busyBlocks([birthday], MENDOZA)).toEqual([]);
  });

  it('un evento de duración cero no bloquea nada', () => {
    const reminder = event({ end: { at: at('2026-11-05', '10:00') } });

    expect(busyBlocks([reminder], MENDOZA)).toEqual([]);
  });

  it('se queda con los que bloquean y descarta los demás', () => {
    const blocks = busyBlocks(
      [event({ id: 'a' }), event({ id: 'b', transparent: true }), event({ id: 'c', start: { at: at('2026-11-05', '15:00') }, end: { at: at('2026-11-05', '16:30') } })],
      MENDOZA,
    );

    expect(blocks).toEqual([
      { start: at('2026-11-05', '10:00'), end: at('2026-11-05', '11:00') },
      { start: at('2026-11-05', '15:00'), end: at('2026-11-05', '16:30') },
    ]);
  });
});
