import { describe, expect, it } from 'vitest';
import {
  evaluateCase,
  normalizeText,
  type EvalCase,
  type EvalResult,
} from '../../evals/evaluate.js';

function result(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    texto: 'Hola, soy Luna.',
    tipo: 'text',
    opciones: [],
    herramientas: [],
    outcome: 'replied',
    tokens: { entrada: 100, salida: 20, cacheLectura: 0, cacheEscritura: 0 },
    latenciaMs: 500,
    ...overrides,
  };
}

const caso = (espera: EvalCase['espera'], mensajes = ['hola']): EvalCase => ({
  nombre: 'caso_de_prueba',
  mensajes,
  espera,
});

describe('normalizeText', () => {
  it('pasa a minúsculas y saca las tildes', () => {
    expect(normalizeText('Crédito')).toBe('credito');
    expect(normalizeText('MIÉRCOLES a la TARDE')).toBe('miercoles a la tarde');
  });

  it('también saca la tilde de la ñ, de los dos lados por igual', () => {
    expect(normalizeText('Uñas')).toBe('unas');
  });

  it('no toca los dígitos ni los signos', () => {
    expect(normalizeText('$18.000 (20 %)')).toBe('$18.000 (20 %)');
    expect(normalizeText('18000')).toBe('18000');
  });
});

describe('evaluateCase: menciona', () => {
  it('pasa si todo lo esperado aparece, sin importar mayúsculas ni tildes', () => {
    const evaluation = evaluateCase(
      caso({ menciona: ['Luna', 'asistente virtual'] }),
      result({ texto: 'Hola! Soy LUNA, la Asistente Virtual de Estética Ejemplo.' }),
    );

    expect(evaluation).toEqual({ ok: true, motivos: [] });
  });

  it('lo esperado puede tener tildes y el texto no', () => {
    const evaluation = evaluateCase(caso({ menciona: ['crédito'] }), result({ texto: 'Aceptamos CREDITO y debito' }));

    expect(evaluation.ok).toBe(true);
  });

  it('falla y dice qué falta', () => {
    const evaluation = evaluateCase(
      caso({ menciona: ['Luna', 'asistente virtual'] }),
      result({ texto: 'Hola, soy Luna.' }),
    );

    expect(evaluation.ok).toBe(false);
    expect(evaluation.motivos).toEqual(['No menciona "asistente virtual"']);
  });

  it('un precio con punto no es el mismo que sin punto', () => {
    const esperado = caso({ menciona: ['18.000'] });

    expect(evaluateCase(esperado, result({ texto: 'Sale $18.000' })).ok).toBe(true);
    expect(evaluateCase(esperado, result({ texto: 'Sale $18000' })).ok).toBe(false);
  });

  it('también busca en los títulos y las descripciones de las opciones', () => {
    const conOpciones = result({
      texto: 'Elegí un horario',
      tipo: 'list',
      opciones: [{ id: 'horario:x', titulo: 'vie 9/10 15:00', descripcion: 'con Mica' }],
    });

    expect(evaluateCase(caso({ menciona: ['vie 9/10'] }), conOpciones).ok).toBe(true);
    expect(evaluateCase(caso({ menciona: ['Mica'] }), conOpciones).ok).toBe(true);
    expect(evaluateCase(caso({ menciona: ['Sofi'] }), conOpciones).ok).toBe(false);
  });

  it('no busca en los ids de las opciones', () => {
    const evaluation = evaluateCase(
      caso({ menciona: ['horario'] }),
      result({
        texto: 'Elegí',
        opciones: [{ id: 'horario:abc', titulo: 'vie 9/10 15:00', descripcion: null }],
      }),
    );

    expect(evaluation.ok).toBe(false);
  });
});

describe('evaluateCase: noMenciona', () => {
  it('pasa si nada de lo prohibido aparece', () => {
    expect(evaluateCase(caso({ noMenciona: ['descuento'] }), result({ texto: 'Sale $18.000' })).ok).toBe(true);
  });

  it('falla si aparece, aunque cambien las mayúsculas o las tildes', () => {
    const evaluation = evaluateCase(
      caso({ noMenciona: ['descuento', 'promoción'] }),
      result({ texto: 'Tenemos un DESCUENTO y una PROMOCION' }),
    );

    expect(evaluation.motivos).toEqual(['Menciona "descuento" y no debería', 'Menciona "promoción" y no debería']);
  });

  it('el signo $ cuenta como texto', () => {
    const esperado = caso({ noMenciona: ['$'] });

    expect(evaluateCase(esperado, result({ texto: 'Eso no lo hacemos' })).ok).toBe(true);
    expect(evaluateCase(esperado, result({ texto: 'Sale $5.000' })).ok).toBe(false);
  });

  it('un precio en el título de una opción también cuenta', () => {
    const evaluation = evaluateCase(
      caso({ noMenciona: ['$'] }),
      result({ opciones: [{ id: 'servicio:x', titulo: 'Semi $18.000', descripcion: null }] }),
    );

    expect(evaluation.ok).toBe(false);
  });
});

describe('evaluateCase: herramientas', () => {
  it('pasa si se llamaron todas, en cualquier orden y aunque haya otras', () => {
    const evaluation = evaluateCase(
      caso({ herramientas: ['buscar_servicios', 'consultar_disponibilidad'] }),
      result({ herramientas: ['consultar_informacion', 'consultar_disponibilidad', 'buscar_servicios'] }),
    );

    expect(evaluation.ok).toBe(true);
  });

  it('falla y nombra las que faltan y las que se llamaron', () => {
    const evaluation = evaluateCase(
      caso({ herramientas: ['buscar_servicios', 'consultar_disponibilidad'] }),
      result({ herramientas: ['buscar_servicios'] }),
    );

    expect(evaluation.motivos).toEqual(['No llamó a consultar_disponibilidad (llamó: buscar_servicios)']);
  });

  it('cuando no llamó a ninguna lo dice', () => {
    const evaluation = evaluateCase(caso({ herramientas: ['consultar_informacion'] }), result());

    expect(evaluation.motivos).toEqual(['No llamó a consultar_informacion (llamó: ninguna)']);
  });
});

describe('evaluateCase: sinHerramientas', () => {
  it('pasa si no llamó a ninguna', () => {
    expect(evaluateCase(caso({ sinHerramientas: true }), result()).ok).toBe(true);
  });

  it('falla si llamó a alguna y las nombra', () => {
    const evaluation = evaluateCase(
      caso({ sinHerramientas: true }),
      result({ herramientas: ['buscar_servicios', 'buscar_servicios'] }),
    );

    expect(evaluation.motivos).toEqual(['No debía llamar herramientas y llamó: buscar_servicios, buscar_servicios']);
  });

  it('sinHerramientas en false no exige nada', () => {
    expect(evaluateCase(caso({ sinHerramientas: false }), result({ herramientas: ['buscar_servicios'] })).ok).toBe(true);
  });
});

describe('evaluateCase: verifica', () => {
  it('pasa si el chequeo devuelve null, y recibe el resultado completo', () => {
    const recibidos: EvalResult[] = [];
    const completo = result({ texto: 'otro texto' });

    const evaluation = evaluateCase(
      caso({
        verifica: (r) => {
          recibidos.push(r);
          return null;
        },
      }),
      completo,
    );

    expect(evaluation.ok).toBe(true);
    expect(recibidos).toEqual([completo]);
  });

  it('falla con el motivo que devuelve el chequeo', () => {
    const evaluation = evaluateCase(
      caso({ verifica: (r) => (r.opciones.length === 0 ? 'No ofreció ningún horario' : null) }),
      result(),
    );

    expect(evaluation).toEqual({ ok: false, motivos: ['No ofreció ningún horario'] });
  });

  it('el chequeo ve las opciones si las hay', () => {
    const verifica = (r: EvalResult) => (r.opciones.length === 0 ? 'No ofreció ningún horario' : null);
    const conOpcion = result({ opciones: [{ id: 'horario:x', titulo: 'vie 9/10 15:00', descripcion: null }] });

    expect(evaluateCase(caso({ verifica }), conOpcion).ok).toBe(true);
  });
});

describe('evaluateCase: varias condiciones y el outcome', () => {
  it('junta todos los motivos en vez de frenar en el primero', () => {
    const evaluation = evaluateCase(
      caso({
        herramientas: ['buscar_servicios'],
        menciona: ['18.000'],
        noMenciona: ['descuento'],
        verifica: () => 'el chequeo extra también falló',
      }),
      result({ texto: 'Hay descuento' }),
    );

    expect(evaluation.motivos).toEqual([
      'No llamó a buscar_servicios (llamó: ninguna)',
      'No menciona "18.000"',
      'Menciona "descuento" y no debería',
      'el chequeo extra también falló',
    ]);
  });

  it('un caso sin expectativas pasa si el agente contestó', () => {
    expect(evaluateCase(caso({}), result()).ok).toBe(true);
  });

  it.each(['fallback_refusal', 'fallback_max_tokens', 'fallback_invalid_output', 'rate_limited'] as const)(
    'falla si el agente no pudo contestar (%s), aunque lo demás cumpla',
    (outcome) => {
      const evaluation = evaluateCase(caso({ noMenciona: ['$'] }), result({ outcome }));

      expect(evaluation.ok).toBe(false);
      expect(evaluation.motivos).toEqual([`El agente no pudo contestar (outcome: ${outcome})`]);
    },
  );

  it('llegar al tope de herramientas cuenta como respuesta: lo juzgan las expectativas', () => {
    expect(evaluateCase(caso({ menciona: ['Luna'] }), result({ outcome: 'tool_limit' })).ok).toBe(true);
  });
});
