import { localDateTimeToInstant } from '../../src/shared/time-zone.js';

/**
 * La hora fija de las evaluaciones (sección 11.4): jueves 8/10/2026 a las 10:00 en Mendoza, para
 * que el resultado no dependa del día en que se corren. Los casos que hablan de "el viernes" o
 * "el lunes" suponen esta fecha.
 */
export const EVAL_TIME_ZONE = 'America/Argentina/Mendoza';
export const EVAL_NOW = localDateTimeToInstant('2026-10-08', '10:00', EVAL_TIME_ZONE);
