import { describe, expect, it } from 'vitest';
import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalSlot,
  formatPesos,
  formatShortSlot,
  truncateText,
} from '../../../src/modules/conversation/format.js';

const MENDOZA = 'America/Argentina/Mendoza';

describe('formatPesos: los precios salen escritos por el código (6.4)', () => {
  it('pasa centavos a pesos con punto de miles y sin decimales', () => {
    expect(formatPesos(1_800_000)).toBe('$18.000');
    expect(formatPesos(500_000)).toBe('$5.000');
  });

  it('agrupa de a tres cifras también en los millones', () => {
    expect(formatPesos(123_456_700)).toBe('$1.234.567');
  });

  it('no agrega separador por debajo de mil', () => {
    expect(formatPesos(99_900)).toBe('$999');
    expect(formatPesos(0)).toBe('$0');
  });

  it('muestra los centavos con coma solo si los hay: no redondea un precio', () => {
    expect(formatPesos(1_800_050)).toBe('$18.000,50');
    expect(formatPesos(1_805)).toBe('$18,05');
  });

  it('rechaza lo que no es una cantidad de centavos', () => {
    expect(() => formatPesos(-1)).toThrow(RangeError);
    expect(() => formatPesos(10.5)).toThrow(RangeError);
  });
});

describe('formatLocalSlot: fechas y horas en español rioplatense, en la zona del negocio', () => {
  it('escribe día de la semana, día/mes y hora', () => {
    // 15:30 en Mendoza (UTC-3) es 18:30 UTC.
    expect(formatLocalSlot(new Date('2026-10-09T18:30:00.000Z'), MENDOZA)).toBe('viernes 9/10 15:30');
  });

  it('la hora de la mañana no lleva cero adelante', () => {
    expect(formatLocalSlot(new Date('2026-10-12T12:00:00.000Z'), MENDOZA)).toBe('lunes 12/10 9:00');
  });

  it('el día es el local aunque en UTC ya sea el siguiente (cruce de medianoche)', () => {
    // 23:30 del viernes 9 en Mendoza es 02:30 del sábado 10 en UTC.
    expect(formatLocalSlot(new Date('2026-10-10T02:30:00.000Z'), MENDOZA)).toBe('viernes 9/10 23:30');
  });

  it('el día es el local aunque en UTC todavía sea el anterior', () => {
    // 00:15 del sábado 10 en Mendoza es 03:15 del mismo día en UTC; 21:00 del jueves 8 ya es el 9 en UTC.
    expect(formatLocalSlot(new Date('2026-10-10T03:15:00.000Z'), MENDOZA)).toBe('sábado 10/10 0:15');
    expect(formatLocalSlot(new Date('2026-10-09T00:00:00.000Z'), MENDOZA)).toBe('jueves 8/10 21:00');
  });

  it('usa los nombres con tilde de miércoles y sábado, y domingo en el 7', () => {
    expect(formatLocalSlot(new Date('2026-10-14T13:00:00.000Z'), MENDOZA)).toBe('miércoles 14/10 10:00');
    expect(formatLocalSlot(new Date('2026-10-11T13:00:00.000Z'), MENDOZA)).toBe('domingo 11/10 10:00');
  });
});

describe('formatLocalDateTime: el momento actual con año, para el contexto del asistente', () => {
  it('escribe día de la semana, fecha con año y hora en la zona del negocio', () => {
    expect(formatLocalDateTime(new Date('2026-10-05T12:00:00.000Z'), MENDOZA)).toBe('lunes 5/10/2026 9:00');
  });

  it('cerca de la medianoche el día es el local, no el de UTC', () => {
    expect(formatLocalDateTime(new Date('2026-12-31T23:59:00.000Z'), MENDOZA)).toBe('jueves 31/12/2026 20:59');
    expect(formatLocalDateTime(new Date('2027-01-01T02:30:00.000Z'), MENDOZA)).toBe('jueves 31/12/2026 23:30');
  });
});

describe('formatShortSlot: el título corto de una opción (máximo 20 caracteres)', () => {
  it('abrevia el día de la semana', () => {
    expect(formatShortSlot(new Date('2026-10-09T18:30:00.000Z'), MENDOZA)).toBe('vie 9/10 15:30');
  });

  it('el peor caso posible entra en 20 caracteres', () => {
    // miércoles 28/10 a las 23:45: la fecha y la hora más largas.
    const title = formatShortSlot(new Date('2026-10-29T02:45:00.000Z'), MENDOZA);
    expect(title).toBe('mié 28/10 23:45');
    expect(title.length).toBeLessThanOrEqual(20);
  });
});

describe('formatLocalDate: un día cargado como AAAA-MM-DD', () => {
  it('escribe el día de la semana y día/mes', () => {
    expect(formatLocalDate('2026-10-12')).toBe('lunes 12/10');
    expect(formatLocalDate('2026-12-01')).toBe('martes 1/12');
  });

  it('rechaza una fecha que no existe', () => {
    expect(() => formatLocalDate('2026-02-30')).toThrow();
  });
});

describe('truncateText: títulos que entran en el límite de WhatsApp', () => {
  it('un texto que entra queda como está, también el que justo mide el límite', () => {
    expect(truncateText('Depilación láser', 20)).toBe('Depilación láser');
    expect(truncateText('12345', 5)).toBe('12345');
  });

  it('corta en el límite de una palabra y agrega puntos suspensivos', () => {
    expect(truncateText('Esmaltado semipermanente', 20)).toBe('Esmaltado…');
    expect(truncateText('Manos y pies semipermanente', 20)).toBe('Manos y pies…');
  });

  it('una sola palabra larga se corta en seco, sin pasarse del límite', () => {
    const cut = truncateText('Supercalifragilisticoexpialidoso', 10);
    expect(cut).toBe('Supercali…');
    expect(cut).toHaveLength(10);
  });

  it('nunca devuelve más que el límite', () => {
    for (const text of ['a b c d e f g h i j k l m n o p', 'Uñas esculpidas con diseño', 'xxxxxxxxxxxxxxxxxxxxxxx']) {
      expect(truncateText(text, 12).length).toBeLessThanOrEqual(12);
    }
  });
});
