import { describe, expect, it } from 'vitest';
import { dayBeforeReminderAt, shortReminderAt } from '../../../src/modules/scheduling/reminders.js';
import { localDateTimeToInstant } from '../../../src/shared/time-zone.js';

const MENDOZA = 'America/Argentina/Mendoza';
const MADRID = 'Europe/Madrid';
const WINDOW = { start: '09:00:00', end: '21:00:00' };

// Octubre de 2026: el 3 es sábado, el 5 lunes, el 6 martes.
const at = (date: string, time: string, timeZone = MENDOZA) =>
  localDateTimeToInstant(date, time, timeZone);

describe('dayBeforeReminderAt (sección 4.7)', () => {
  const remind = (appointmentStart: Date, bookedAt = at('2026-10-01', '10:00')) =>
    dayBeforeReminderAt({ appointmentStart, bookedAt, timeZone: MENDOZA, window: WINDOW });

  it('sale el día anterior a la misma hora del turno', () => {
    expect(remind(at('2026-10-06', '15:30'))).toEqual(at('2026-10-05', '15:30'));
  });

  it.each([
    ['09:00', '2026-10-05', '09:00'],
    ['21:00', '2026-10-05', '21:00'],
  ])('un turno a las %s respeta el borde de la ventana de 9 a 21', (time, date, expected) => {
    expect(remind(at('2026-10-06', time))).toEqual(at(date, expected));
  });

  it('si caería después de las 21, se adelanta a las 21 de ese día', () => {
    expect(remind(at('2026-10-06', '22:00'))).toEqual(at('2026-10-05', '21:00'));
  });

  it('si caería antes de las 9, se adelanta a las 21 del día anterior', () => {
    expect(remind(at('2026-10-06', '08:00'))).toEqual(at('2026-10-04', '21:00'));
  });

  it('se omite si el turno se reservó con menos de 24 horas', () => {
    expect(remind(at('2026-10-06', '15:30'), at('2026-10-05', '16:00'))).toBeNull();
  });

  it('se omite si, al adelantarse, quedaría antes de la reserva', () => {
    // Reservado el lunes 22:00 para el miércoles 08:00: tocaría el lunes 21:00.
    expect(remind(at('2026-10-07', '08:00'), at('2026-10-05', '22:00'))).toBeNull();
  });

  it('mantiene la hora local aunque en el medio cambie el horario de verano', () => {
    // En Madrid el 29/03 se adelanta el reloj: entre las dos 10:00 hay 23 horas.
    expect(
      dayBeforeReminderAt({
        appointmentStart: at('2026-03-30', '10:00', MADRID),
        bookedAt: at('2026-03-20', '10:00', MADRID),
        timeZone: MADRID,
        window: WINDOW,
      }),
    ).toEqual(at('2026-03-29', '10:00', MADRID));
  });
});

describe('shortReminderAt (sección 4.7, opcional)', () => {
  const remind = (appointmentStart: Date, bookedAt = at('2026-10-01', '10:00')) =>
    shortReminderAt({ appointmentStart, bookedAt, timeZone: MENDOZA, window: WINDOW });

  it('sale 2 horas antes del turno', () => {
    expect(remind(at('2026-10-06', '15:30'))).toEqual(at('2026-10-06', '13:30'));
  });

  it('se omite si 2 horas antes cae fuera de la ventana de 9 a 21', () => {
    expect(remind(at('2026-10-06', '10:00'))).toBeNull();
  });

  it('se omite si el turno se reservó hace menos de 2 horas', () => {
    expect(remind(at('2026-10-06', '15:30'), at('2026-10-06', '14:00'))).toBeNull();
  });
});
