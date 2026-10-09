import { describe, expect, it } from 'vitest';
import { choiceIds } from '../../../src/modules/conversation/tools/choice-ids.js';
import { localDateTimeToInstant } from '../../../src/shared/time-zone.js';
import { evalCases } from '../../evals/cases.js';
import { EVAL_NOW, EVAL_TIME_ZONE } from '../../evals/clock.js';
import type { EvalCase, EvalOption, EvalResult } from '../../evals/evaluate.js';

const SERVICE = '00000000-0000-4000-8000-000000000201';
const MICA = '00000000-0000-4000-8000-000000000101';

const at = (date: string, time: string) => localDateTimeToInstant(date, time, EVAL_TIME_ZONE);

function offered(start: Date): EvalOption {
  return {
    id: choiceIds.slot(SERVICE, MICA, start),
    titulo: 'horario',
    descripcion: null,
    resuelta: {
      tipo: 'horario',
      servicioId: SERVICE,
      servicioNombre: 'Esmaltado semipermanente',
      profesionalId: MICA,
      profesionalNombre: 'Mica',
      inicio: start.toISOString(),
      texto: 'texto',
      duracionMinutos: 60,
      sigueLibre: true,
    },
  };
}

function resultWith(...starts: Date[]): EvalResult {
  return {
    texto: 'Tengo estos horarios',
    tipo: 'list',
    opciones: starts.map(offered),
    herramientas: [],
    outcome: 'replied',
    tokens: { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 },
    latenciaMs: 1,
  };
}

function byName(name: string): EvalCase {
  const found = evalCases.find((evalCase) => evalCase.nombre === name);
  if (!found) throw new Error(`No existe el caso ${name}`);
  return found;
}

describe('la hora fija de las evaluaciones', () => {
  it('es el jueves 8/10/2026 a las 10:00 de Mendoza (SPEC 11.4)', () => {
    expect(EVAL_NOW.toISOString()).toBe('2026-10-08T13:00:00.000Z');
    expect(EVAL_TIME_ZONE).toBe('America/Argentina/Mendoza');
  });
});

describe('evalCases', () => {
  it('son las 10 primeras evaluaciones de H7 más la que sumó la prueba manual, en orden', () => {
    expect(evalCases.map((evalCase) => evalCase.nombre)).toEqual([
      'presentacion',
      'precio_semi_simple',
      'precio_desde',
      'fuera_de_catalogo',
      'direccion',
      'medios_de_pago',
      'promo',
      'disponibilidad_viernes_tarde',
      'feriado',
      'inyeccion_precio',
      'turno_sin_servicio',
    ]);
  });

  it('cada una tiene mensajes de la clienta y al menos una expectativa', () => {
    for (const { nombre, mensajes, espera } of evalCases) {
      expect(mensajes.length, nombre).toBeGreaterThan(0);
      expect(mensajes.every((mensaje) => mensaje.trim() !== ''), nombre).toBe(true);
      expect(Object.keys(espera).length, nombre).toBeGreaterThan(0);
    }
  });

  it('los nombres no se repiten (son el nombre de cada test)', () => {
    const names = evalCases.map((evalCase) => evalCase.nombre);

    expect(new Set(names).size).toBe(names.length);
  });
});

describe('disponibilidad_viernes_tarde: verifica', () => {
  const verifica = byName('disponibilidad_viernes_tarde').espera.verifica;

  it('acepta horarios del viernes 9/10 de las 13:00 en adelante que siguen libres', () => {
    expect(verifica?.(resultWith(at('2026-10-09', '15:00'), at('2026-10-09', '16:30')))).toBeNull();
  });

  it('rechaza si no ofreció horarios', () => {
    expect(verifica?.(resultWith())).toBe('No ofreció ningún horario');
  });

  it('rechaza un horario de la mañana del viernes y uno de otro día', () => {
    expect(verifica?.(resultWith(at('2026-10-09', '10:00')))).toContain('2026-10-09 10:00');
    expect(verifica?.(resultWith(at('2026-10-10', '15:00')))).toContain('2026-10-10 15:00');
  });
});

describe('feriado: verifica', () => {
  const verifica = byName('feriado').espera.verifica;

  it('rechaza un horario el lunes 12/10 (Día de la Raza)', () => {
    expect(verifica?.(resultWith(at('2026-10-12', '15:00')))).toContain('2026-10-12 15:00');
  });

  it('acepta no ofrecer nada, o ofrecer el martes siguiente', () => {
    expect(verifica?.(resultWith())).toBeNull();
    expect(verifica?.(resultWith(at('2026-10-13', '10:00')))).toBeNull();
  });
});
