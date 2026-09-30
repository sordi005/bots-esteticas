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
});
