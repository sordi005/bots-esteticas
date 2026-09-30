import { sql, type SQL } from 'drizzle-orm';
import { check, customType, timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  formatTimestampRange,
  parseTimestampRange,
  type TimestampRange,
} from './timestamp-range.js';

/** `tstzrange` de Postgres, siempre semiabierto [inicio, fin). */
export const timestampRange = customType<{ data: TimestampRange; driverData: string }>({
  dataType: () => 'tstzrange',
  toDriver: formatTimestampRange,
  fromDriver: parseTimestampRange,
});

/** Datos binarios. Se usa para las credenciales cifradas. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** Un instante: `timestamptz`, guardado en UTC (CLAUDE.md, regla 5). */
export const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => instant('created_at').notNull().defaultNow();

/** Se actualiza solo en cada UPDATE hecho con Drizzle. */
export const updatedAt = () =>
  instant('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate((): SQL => sql`now()`);

/** El rango no puede ser vacío ni infinito, y tiene que ser [inicio, fin). */
export const halfOpenRangeCheck = (name: string, column: AnyPgColumn) =>
  check(
    name,
    sql`not isempty(${column}) and lower_inc(${column}) and not upper_inc(${column})
      and not lower_inf(${column}) and not upper_inf(${column})`,
  );

/** Teléfono en formato internacional E.164, por ejemplo +5492614000000. */
export const e164Check = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} ~ '^\\+[1-9][0-9]{7,14}$'`);
