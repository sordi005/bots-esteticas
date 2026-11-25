import { between } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { holidays } from '../../src/modules/catalog/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';

const database = createDatabase(testDatabaseUrl());

afterAll(() => database.close());

async function holidaysOf(year: number): Promise<string[]> {
  const rows = await database.db
    .select({ date: holidays.date })
    .from(holidays)
    .where(between(holidays.date, `${String(year)}-01-01`, `${String(year)}-12-31`))
    .orderBy(holidays.date);
  return rows.map((row) => row.date);
}

describe('feriados nacionales (argentina.gob.ar/feriados)', () => {
  // Lista exacta: tampoco puede sobrar nada. Los días no laborables (puentes turísticos
  // del 23/3, 10/7 y 7/12, días religiosos y feriados solo regionales) no se cargan,
  // porque para el sector privado son optativos.
  it('las migraciones cargan los feriados nacionales de 2026 en su fecha efectiva', async () => {
    expect(await holidaysOf(2026)).toEqual([
      '2026-01-01',
      '2026-02-16',
      '2026-02-17',
      '2026-03-24',
      '2026-04-02',
      '2026-04-03',
      '2026-05-01',
      '2026-05-25',
      '2026-06-15', // Güemes, trasladado del 17/6
      '2026-06-20',
      '2026-07-09',
      '2026-08-17',
      '2026-10-12',
      '2026-11-09', // Visita del Papa León XIV (Decreto 1103/2026)
      '2026-11-23', // Soberanía Nacional, trasladado del 20/11
      '2026-12-08',
      '2026-12-25',
    ]);
  });

  // La lista oficial de 2027 no está publicada: se cargan solo los inamovibles, que fija
  // la Ley 27.399 (art. 1) y solo puede mover el Congreso. Los trasladables (Güemes,
  // San Martín, Diversidad Cultural y Soberanía Nacional) entran con la lista oficial.
  it('las migraciones cargan los feriados inamovibles de 2027, sin los trasladables', async () => {
    expect(await holidaysOf(2027)).toEqual([
      '2027-01-01',
      '2027-02-08', // Carnaval: Pascua es el 28/3/2027
      '2027-02-09',
      '2027-03-24',
      '2027-03-26', // Viernes Santo
      '2027-04-02',
      '2027-05-01',
      '2027-05-25',
      '2027-06-20',
      '2027-07-09',
      '2027-12-08',
      '2027-12-25',
    ]);
  });
});
