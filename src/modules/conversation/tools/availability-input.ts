import { z } from 'zod';
import { addDaysToLocalDate, isoWeekday } from '../../../shared/time-zone.js';
import { parseAppointmentRef } from './choice-ids.js';

/** Cuántos días puede abarcar una consulta de disponibilidad, contando el primero y el último [S]. */
export const MAX_AVAILABILITY_RANGE_DAYS = 7;

export const DAY_PERIODS = ['manana', 'tarde', 'noche'] as const;
export type DayPeriod = (typeof DAY_PERIODS)[number];

/** Franjas [S], por la hora local de inicio del turno: mañana antes de las 13, tarde de 13 a 17, noche desde las 17. */
const AFTERNOON_STARTS_AT_MINUTES = 13 * 60;
const EVENING_STARTS_AT_MINUTES = 17 * 60;

export function periodOfDay(minutesOfDay: number): DayPeriod {
  if (minutesOfDay < AFTERNOON_STARTS_AT_MINUTES) return 'manana';
  return minutesOfDay < EVENING_STARTS_AT_MINUTES ? 'tarde' : 'noche';
}

function isRealDate(date: string): boolean {
  try {
    isoWeekday(date); // lanza si el día no existe en el calendario
    return true;
  } catch {
    return false;
  }
}

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD')
  .refine(isRealDate, 'Esa fecha no existe');

/** Lo que tienen en común las dos consultas de horarios: el rango, la franja y el cursor de "ver otros horarios". */
const searchFields = {
  desde: localDate.describe('Primer día a buscar, fecha local del negocio AAAA-MM-DD.'),
  hasta: localDate.describe(
    `Último día a buscar (incluido), AAAA-MM-DD. Hasta ${String(MAX_AVAILABILITY_RANGE_DAYS)} días en total.`,
  ),
  franja: z
    .enum(DAY_PERIODS)
    .optional()
    .describe('Si la clienta pidió mañana (antes de las 13), tarde (13 a 17) o noche (desde las 17).'),
  despues_de: z.iso
    .datetime()
    .optional()
    .describe('Para "ver otros horarios": el inicio (UTC) del último horario ofrecido, tal como vino en la opción.'),
};

/** El rango: "hasta" no antes que "desde" y de hasta 7 días [S]. */
function checkRange(value: { desde: string; hasta: string }, ctx: z.RefinementCtx): void {
  // Si alguna fecha es inválida, ya tiene su propio error: no se compara.
  if (!isRealDate(value.desde) || !isRealDate(value.hasta)) return;
  if (value.hasta < value.desde) {
    ctx.addIssue({ code: 'custom', path: ['hasta'], message: '"hasta" no puede ser anterior a "desde"' });
  } else if (value.hasta > addDaysToLocalDate(value.desde, MAX_AVAILABILITY_RANGE_DAYS - 1)) {
    ctx.addIssue({
      code: 'custom',
      path: ['hasta'],
      message: `El rango no puede superar los ${String(MAX_AVAILABILITY_RANGE_DAYS)} días: pedí una semana por vez`,
    });
  }
}

/**
 * Lo que puede pedir el modelo para RESERVAR. El negocio y la clienta NO están acá: salen del contexto.
 * Las fechas son locales del negocio; el código las pasa a instantes. El servicio es obligatorio:
 * reprogramar un turno tiene su propia herramienta (decisión 28).
 */
export const availabilityInput = z
  .object({
    servicio_id: z.uuid().describe('Id del servicio (lo devuelve buscar_servicios).'),
    profesional_id: z
      .uuid()
      .optional()
      .describe('Solo si la clienta pidió una profesional puntual. Si no, no lo mandes.'),
    ...searchFields,
  })
  .superRefine(checkRange);

export type AvailabilityInput = z.infer<typeof availabilityInput>;

/**
 * El turno de la clienta que se quiere mover, tal como lo ve el modelo (`turno:<uuid>` o el uuid solo).
 * Se guarda sin el prefijo.
 */
const appointmentIdField = z
  .string()
  .transform((ref, ctx) => {
    const appointmentId = parseAppointmentRef(ref);
    if (appointmentId === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'No es el id de un turno: usá el turnoId de listar_turnos_de_la_clienta, sin cambiarlo',
      });
      return z.NEVER;
    }
    return appointmentId;
  })
  .describe(
    'El turno de la clienta que quiere mover: el turnoId que devolvió listar_turnos_de_la_clienta (o el ' +
      'turno_id del contexto), tal cual.',
  );

/**
 * Lo que puede pedir el modelo para REPROGRAMAR un turno: el turno (obligatorio) y las fechas. El
 * servicio, la profesional, la duración y el margen son los del turno: no hay dónde mandarlos.
 * El turno se guarda sin el prefijo `turno:`.
 */
export const rescheduleAvailabilityInput = z
  .object({
    turno_id: appointmentIdField,
    ...searchFields,
  })
  .superRefine(checkRange);

export type RescheduleAvailabilityInput = z.infer<typeof rescheduleAvailabilityInput>;

/** Una hora local del negocio, HH:MM en 24 horas. La conversión a un instante la hace el código. */
const localTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'La hora va como HH:MM (24 horas), por ejemplo 16:30');

/** Lo que tienen en común las dos consultas de una hora puntual: el día y la hora, locales del negocio. */
const timeFields = {
  fecha: localDate.describe('El día, fecha local del negocio AAAA-MM-DD.'),
  hora: localTime.describe(
    'La hora puntual que pregunta la clienta, hora local del negocio HH:MM en 24 horas (por ejemplo 16:30, 20:00). ' +
      'No la conviertas: escribí la hora tal cual la dijo.',
  ),
};

/**
 * Lo que puede pedir el modelo para saber si una HORA PUNTUAL está libre para RESERVAR (6.4,
 * decisión 29). Servicio, fecha y hora son obligatorios; la profesional es un filtro opcional como en
 * `consultar_disponibilidad` y no cambia lo que hace la herramienta. Mover un turno tiene la suya.
 */
export const timeQueryInput = z.object({
  servicio_id: z.uuid().describe('Id del servicio (lo devuelve buscar_servicios).'),
  profesional_id: z.uuid().optional().describe('Solo si la clienta pidió una profesional puntual. Si no, no lo mandes.'),
  ...timeFields,
});

export type TimeQueryInput = z.infer<typeof timeQueryInput>;

/**
 * Lo que puede pedir el modelo para saber si una HORA PUNTUAL está libre para MOVER un turno: el turno
 * (obligatorio), la fecha y la hora. El servicio, la profesional, la duración y el margen son los del turno.
 */
export const rescheduleTimeQueryInput = z.object({
  turno_id: appointmentIdField,
  ...timeFields,
});

export type RescheduleTimeQueryInput = z.infer<typeof rescheduleTimeQueryInput>;
