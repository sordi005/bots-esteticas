import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmRequest } from '../../src/modules/conversation/agent/llm-client.js';
import { agentRuns, conversations, messages } from '../../src/modules/conversation/schema.js';
import { choiceIds } from '../../src/modules/conversation/tools/choice-ids.js';
import { consultationTools } from '../../src/modules/conversation/tools/index.js';
import { runTool, type ToolContext } from '../../src/modules/conversation/tools/tool.js';
import { DEMO_TENANT_ID, seedEsteticaEjemplo } from '../../src/seeds/estetica-ejemplo.js';
import { createDatabase } from '../../src/shared/db.js';
import { evalCases } from '../evals/cases.js';
import { EVAL_NOW, EVAL_TIME_ZONE } from '../evals/clock.js';
import { evaluateCase, type EvalCase } from '../evals/evaluate.js';
import { runEvalCase } from '../evals/run-case.js';
import { callTools, finalAnswer, scriptedLlm, type ScriptStep } from '../support/fake-llm.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';

/**
 * La infraestructura de las evaluaciones (tests/evals/) con un modelo falso guionado: prueba el
 * armado (clienta, conversación, mensajes, agente real, lectura de `agent_runs` y de las
 * opciones) sin gastar plata. Las evaluaciones de verdad están en tests/evals/run.eval.ts.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;

// Los ids fijos del seed de "Estética Ejemplo".
const SEMI = '00000000-0000-4000-8000-000000000201';
const PERFILADO = '00000000-0000-4000-8000-000000000207';

beforeAll(() => seedEsteticaEjemplo(db));
afterAll(() => database.close());

function byName(name: string): EvalCase {
  const found = evalCases.find((evalCase) => evalCase.nombre === name);
  if (!found) throw new Error(`No existe el caso ${name}`);
  return found;
}

function run(evalCase: EvalCase, script: ScriptStep[]) {
  const { llm, requests } = scriptedLlm(script);
  const result = runEvalCase({ db, llm, tenantId: DEMO_TENANT_ID }, evalCase);
  return { result, requests };
}

/** Lo que devolvieron las herramientas en el último pedido al modelo, ya leído como JSON. */
function lastToolOutputs(request: LlmRequest): Record<string, unknown>[] {
  const last = request.messages.at(-1);
  if (last?.role !== 'tool_results') throw new Error('El último mensaje no son resultados de herramientas');
  return last.results.map((result) => JSON.parse(result.content) as Record<string, unknown>);
}

describe('runEvalCase: precio_semi_simple con un modelo falso', () => {
  const evalCase = byName('precio_semi_simple');
  const script = (): ScriptStep[] => [
    callTools([{ name: 'buscar_servicios', input: { texto: 'semi' } }]),
    finalAnswer('El esmaltado semipermanente sale $18.000.'),
  ];

  it('devuelve el texto, las herramientas, el outcome, los tokens y la latencia', async () => {
    const { result } = run(evalCase, script());
    const evaluated = await result;

    expect(evaluated.texto).toBe('El esmaltado semipermanente sale $18.000.');
    expect(evaluated.tipo).toBe('text');
    expect(evaluated.opciones).toEqual([]);
    expect(evaluated.herramientas).toEqual(['buscar_servicios']);
    expect(evaluated.outcome).toBe('replied');
    // Dos llamadas al modelo falso, cada una con 100 tokens de entrada y 20 de salida.
    expect(evaluated.tokens).toEqual({ entrada: 200, salida: 40, cacheLectura: 0, cacheEscritura: 0 });
    expect(evaluated.latenciaMs).toBeGreaterThanOrEqual(0);
  });

  it('evaluateCase lo da por bueno', async () => {
    const evaluated = await run(evalCase, script()).result;

    expect(evaluateCase(evalCase, evaluated)).toEqual({ ok: true, motivos: [] });
  });

  it('si el modelo no llama a la herramienta ni dice el precio, evaluateCase lo marca', async () => {
    const evaluated = await run(evalCase, [finalAnswer('Tenemos descuento en todo.')]).result;

    expect(evaluateCase(evalCase, evaluated).motivos).toEqual([
      'No llamó a buscar_servicios (llamó: ninguna)',
      'No menciona "18.000"',
      'Menciona "descuento" y no debería',
    ]);
  });

  it('el modelo recibe a la hora fija: jueves 8/10/2026 10:00 de Mendoza', async () => {
    const { result, requests } = run(evalCase, script());
    await result;

    expect(EVAL_NOW.toISOString()).toBe('2026-10-08T13:00:00.000Z');
    expect(requests[0]?.turnContext).toContain('jueves 8/10/2026 10:00');
    expect(requests[0]?.turnContext).toContain(`(${EVAL_TIME_ZONE})`);
  });
});

describe('runEvalCase: el armado', () => {
  it('cada caso usa una clienta y una conversación nuevas del negocio del seed', async () => {
    const countConversations = async () =>
      single(await db.select({ total: count() }).from(conversations).where(eq(conversations.tenantId, DEMO_TENANT_ID)))
        .total;
    const evalCase = byName('presentacion');
    const before = await countConversations();

    const first = run(evalCase, [finalAnswer('Hola, soy Luna.')]);
    await first.result;
    const second = run(evalCase, [finalAnswer('Hola, soy Luna.')]);
    await second.result;

    expect((await countConversations()) - before).toBe(2);
    // Cada una arranca de cero: es una conversación nueva y no ve nada de la anterior.
    expect(first.requests[0]?.turnContext).toContain('Conversación nueva: sí');
    expect(second.requests[0]?.turnContext).toContain('Conversación nueva: sí');
    expect(second.requests[0]?.messages).toEqual([{ role: 'user', text: 'hola' }]);
  });

  it('los mensajes de la clienta entran juntos y en orden, y quedan guardados como entrantes sin procesar', async () => {
    const evalCase: EvalCase = {
      nombre: 'varios_mensajes',
      mensajes: ['hola', 'quería saber', 'si tenés turno mañana'],
      espera: { menciona: ['hola'] },
    };
    const { result, requests } = run(evalCase, [finalAnswer('hola, contame')]);
    await result;

    expect(requests[0]?.messages).toEqual([
      { role: 'user', text: 'hola' },
      { role: 'user', text: 'quería saber' },
      { role: 'user', text: 'si tenés turno mañana' },
    ]);
  });

  it('guarda una fila de agent_runs por caso, de donde salen las herramientas', async () => {
    const evalCase = byName('direccion');
    const before = single(await db.select({ total: count() }).from(agentRuns)).total;
    const evaluated = await run(evalCase, [
      callTools([{ name: 'consultar_informacion', input: { tema: 'direccion' } }]),
      finalAnswer('Estamos en Calle Ejemplo 123, Ciudad de Mendoza.'),
    ]).result;
    const after = single(await db.select({ total: count() }).from(agentRuns)).total;

    expect(after - before).toBe(1);
    expect(evaluated.herramientas).toEqual(['consultar_informacion']);
    expect(evaluateCase(evalCase, evaluated).ok).toBe(true);
  });

  it('un mensaje de la clienta queda como entrante del negocio del seed', async () => {
    const evalCase: EvalCase = { nombre: 'un_mensaje', mensajes: ['mensaje-único-del-test'], espera: {} };
    await run(evalCase, [finalAnswer('ok')]).result;

    const inbound = await db
      .select({ content: messages.content, processedAt: messages.processedAt })
      .from(messages)
      .where(eq(messages.tenantId, DEMO_TENANT_ID));
    const saved = inbound.filter((row) => JSON.stringify(row.content).includes('mensaje-único-del-test'));
    expect(saved).toEqual([{ content: { type: 'text', text: { body: 'mensaje-único-del-test' } }, processedAt: null }]);
  });
});

describe('runEvalCase: opciones', () => {
  it('lee los botones o la lista del mensaje y vuelve a resolver cada horario contra la base', async () => {
    const evalCase = byName('disponibilidad_viernes_tarde');
    const evaluated = await run(evalCase, [
      callTools([
        { name: 'buscar_servicios', input: { texto: 'semi' } },
        {
          name: 'consultar_disponibilidad',
          input: { servicio_id: SEMI, desde: '2026-10-09', hasta: '2026-10-09', franja: 'tarde' },
        },
      ]),
      (request) => {
        const availability = lastToolOutputs(request)[1] as { horarios: { opcionId: string }[] };
        return finalAnswer('Para el viernes tengo estos horarios:', availability.horarios.map((h) => h.opcionId));
      },
    ]).result;

    expect(['buttons', 'list']).toContain(evaluated.tipo);
    expect(evaluated.opciones.length).toBeGreaterThanOrEqual(1);
    const slots = evaluated.opciones.filter((option) => option.id.startsWith('horario:'));
    expect(slots.length).toBeGreaterThanOrEqual(1);
    for (const slot of slots) {
      expect(slot.resuelta).toMatchObject({ tipo: 'horario', sigueLibre: true, servicioId: SEMI });
    }
    expect(evaluateCase(evalCase, evaluated)).toEqual({ ok: true, motivos: [] });
  });

  it('con 4 opciones es una lista: las filas traen título y descripción, y "menciona" busca en las dos', async () => {
    const evaluated = await run(
      { nombre: 'opciones', mensajes: ['tenés turno el viernes?'], espera: {} },
      [
        callTools([{ name: 'consultar_disponibilidad', input: { servicio_id: SEMI, desde: '2026-10-09', hasta: '2026-10-09' } }]),
        (request) => {
          const availability = lastToolOutputs(request)[0] as { horarios: { opcionId: string; inicio: string }[] };
          const ids = availability.horarios.map((horario) => horario.opcionId);
          const last = availability.horarios.at(-1);
          // El cuarto es "Ver otros horarios": con más de 3 opciones WhatsApp pide una lista.
          if (last) ids.push(choiceIds.more(SEMI, null, new Date(last.inicio)));
          return finalAnswer('Elegí uno', ids);
        },
      ],
    ).result;

    expect(evaluated.tipo).toBe('list');
    expect(evaluated.texto).toBe('Elegí uno');
    expect(evaluated.opciones.at(-1)).toMatchObject({ titulo: 'Ver otros horarios', descripcion: null });
    const slots = evaluated.opciones.filter((option) => option.id.startsWith('horario:'));
    expect(slots).toHaveLength(3);
    expect(slots.every((slot) => /^vie 9\/10 \d+:\d\d$/.test(slot.titulo))).toBe(true);
    expect(slots.every((slot) => /^con (Mica|Sofi)$/.test(slot.descripcion ?? ''))).toBe(true);

    const mentions = (menciona: string[]) =>
      evaluateCase({ nombre: 'opciones', mensajes: [], espera: { menciona } }, evaluated);
    // El texto de la respuesta no dice nada de esto: sale de los títulos y las descripciones.
    expect(mentions(['vie 9/10', 'otros horarios', 'con Mica'])).toEqual({ ok: true, motivos: [] });
    expect(mentions(['sab 10/10']).ok).toBe(false);
  });

  it('con 1 a 3 opciones son botones: solo tienen título', async () => {
    const evaluated = await run(
      { nombre: 'botones', mensajes: ['tenés turno el viernes?'], espera: {} },
      [
        callTools([{ name: 'consultar_disponibilidad', input: { servicio_id: SEMI, desde: '2026-10-09', hasta: '2026-10-09' } }]),
        (request) => {
          const availability = lastToolOutputs(request)[0] as { horarios: { opcionId: string }[] };
          return finalAnswer('Elegí uno', availability.horarios.slice(0, 2).map((horario) => horario.opcionId));
        },
      ],
    ).result;

    expect(evaluated.tipo).toBe('buttons');
    expect(evaluated.opciones).toHaveLength(2);
    expect(evaluated.opciones.every((option) => option.descripcion === null)).toBe(true);
    expect(evaluated.opciones.every((option) => option.resuelta?.tipo === 'horario')).toBe(true);
  });

  it('el caso del feriado: ofrecer solo el martes siguiente cumple, y decir "feriado" también', async () => {
    const evalCase = byName('feriado');
    const evaluated = await run(evalCase, [
      callTools([
        { name: 'consultar_disponibilidad', input: { servicio_id: PERFILADO, desde: '2026-10-12', hasta: '2026-10-12' } },
      ]),
      (request) => {
        const availability = lastToolOutputs(request)[0] as { proximoHorario?: { opcionId: string } };
        return finalAnswer(
          'El lunes 12/10 es feriado y no abrimos. El próximo lugar es:',
          availability.proximoHorario ? [availability.proximoHorario.opcionId] : [],
        );
      },
    ]).result;

    expect(evaluateCase(evalCase, evaluated)).toEqual({ ok: true, motivos: [] });
  });
});

describe('los datos del seed respaldan lo que esperan las evaluaciones', () => {
  const ctx = (): ToolContext => ({
    db,
    tenantId: DEMO_TENANT_ID,
    customerId: '00000000-0000-4000-8000-000000000000',
    now: EVAL_NOW,
    timeZone: EVAL_TIME_ZONE,
    signal: new AbortController().signal,
  });

  async function toolText(name: string, input: unknown): Promise<string> {
    const tool = consultationTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No existe la herramienta ${name}`);
    return JSON.stringify((await runTool(tool, input, ctx())).content);
  }

  it('el semi sale $18.000 y las esculpidas son "desde" $28.000', async () => {
    expect(await toolText('buscar_servicios', { texto: 'semi' })).toContain('$18.000');
    const sculpted = await toolText('buscar_servicios', { texto: 'uñas esculpidas' });
    expect(sculpted).toContain('desde $28.000');
  });

  it('los masajes descontracturantes no están en el catálogo', async () => {
    expect(await toolText('buscar_servicios', { texto: 'masajes descontracturantes' })).toContain('No está en el catálogo');
  });

  it('dirección, tarjeta de crédito y promoción de los martes están cargadas', async () => {
    expect(await toolText('consultar_informacion', { tema: 'direccion' })).toContain('Calle Ejemplo 123');
    expect(await toolText('consultar_informacion', { tema: 'medios_de_pago' })).toContain('crédito');
    const promo = await toolText('consultar_informacion', { tema: 'promociones' });
    expect(promo).toContain('martes');
    expect(promo).toContain('20');
  });

  it('el lunes 12/10 figura como feriado', async () => {
    const text = await toolText('consultar_disponibilidad', { servicio_id: PERFILADO, desde: '2026-10-12', hasta: '2026-10-12' });

    expect(text).toContain('feriado');
    expect(text).toContain('"horarios":[]');
  });

  it('hay lugar el viernes 9/10 a la tarde para el semi', async () => {
    const text = await toolText('consultar_disponibilidad', {
      servicio_id: SEMI,
      desde: '2026-10-09',
      hasta: '2026-10-09',
      franja: 'tarde',
    });

    // La franja "tarde" arranca a las 13:00 inclusive: el primer lugar es Sofi a la 13:00.
    expect(text).toContain('viernes 9/10 13:00');
    expect(text).not.toContain('viernes 9/10 12');
  });
});
