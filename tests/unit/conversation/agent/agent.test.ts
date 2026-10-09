import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  FALLBACK_REPLY_TEXT,
  MAX_TOOL_CALLS_PER_REPLY,
  runAgent,
  type AgentInput,
} from '../../../../src/modules/conversation/agent/agent.js';
import type { LlmMessage } from '../../../../src/modules/conversation/agent/llm-client.js';
import type { AgentTool, OfferableOption, ToolContext } from '../../../../src/modules/conversation/tools/tool.js';
import { createLogger } from '../../../../src/shared/logger.js';
import { callTools, finalAnswer, rawAnswer, scriptedLlm, type ScriptStep } from '../../../support/fake-llm.js';

const logger = createLogger({ logLevel: 'silent' });

const toolContext: ToolContext = {
  db: drizzle.mock(),
  tenantId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
  now: new Date('2026-10-04T12:00:00.000Z'),
  timeZone: 'America/Argentina/Mendoza',
  signal: new AbortController().signal,
};

const SEMI: OfferableOption = { id: 'servicio:semi', title: 'Semipermanente', description: '60 min' };
const ESCULPIDAS: OfferableOption = { id: 'servicio:esculpidas', title: 'Uñas esculpidas' };
const PIES: OfferableOption = { id: 'servicio:pies', title: 'Semi en pies' };

/** Una herramienta que ofrece las opciones dadas y anota con qué se la llamó. */
function fakeTool(name: string, options: OfferableOption[] = []) {
  interface Input {
    texto?: string | undefined;
  }
  const run = vi.fn<AgentTool<Input>['run']>(() =>
    Promise.resolve({ content: { servicios: options.map((option) => option.title) }, options }),
  );
  const tool: AgentTool<Input> = {
    name,
    description: `Herramienta de prueba ${name}.`,
    input: z.object({ texto: z.string().min(1).optional() }),
    run,
  };
  return { tool: tool as AgentTool<unknown>, run };
}

const HISTORY: LlmMessage[] = [
  { role: 'user', text: 'Hola' },
  { role: 'assistant', text: 'Hola, soy Luna.' },
  { role: 'user', text: '¿Cuánto sale el semi?' },
];

function agent(script: ScriptStep[], tools: AgentTool<unknown>[] = [], input: Partial<AgentInput> = {}) {
  const { llm, requests } = scriptedLlm(script);
  const run = (override: Partial<AgentInput> = {}) =>
    runAgent(
      { llm, tools, logger },
      {
        system: 'SISTEMA',
        turnContext: 'CONTEXTO',
        history: HISTORY,
        toolContext,
        ...input,
        ...override,
      },
    );
  return { run, requests };
}

describe('runAgent: una respuesta directa', () => {
  it('contesta con un mensaje de texto y le pasa al modelo el sistema, el contexto, el historial y las herramientas', async () => {
    const search = fakeTool('buscar_servicios');
    const { run, requests } = agent([finalAnswer('El semi sale $18.000.')], [search.tool]);

    const { message, run: record } = await run();

    expect(message).toEqual({ type: 'text', body: 'El semi sale $18.000.' });
    expect(record).toMatchObject({ outcome: 'replied', llmCalls: 1, toolCalls: [], model: 'modelo-de-prueba' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      system: 'SISTEMA',
      turnContext: 'CONTEXTO',
      messages: HISTORY,
      allowTools: true,
      tools: [{ name: 'buscar_servicios', description: 'Herramienta de prueba buscar_servicios.' }],
    });
    expect(requests[0]?.tools[0]?.inputSchema).toMatchObject({ type: 'object' });
    expect(requests[0]?.responseSchema).toMatchObject({
      type: 'object',
      required: ['texto', 'opciones'],
      additionalProperties: false,
    });
  });

  it('el esquema de la respuesta final no trae restricciones que los proveedores rechazan', async () => {
    const { run, requests } = agent([finalAnswer('Hola')]);

    await run();

    const schema = JSON.stringify(requests[0]?.responseSchema);
    expect(schema).not.toMatch(/minLength|maxLength|\$schema/);
  });

  it('recorta un texto más largo que el máximo de WhatsApp en vez de perder la respuesta', async () => {
    const { run } = agent([finalAnswer('a'.repeat(5_000))]);

    const { message } = await run();

    expect(message.type).toBe('text');
    expect(message.type === 'text' && message.body.length).toBe(4_096);
  });
});

describe('runAgent: el ciclo de herramientas', () => {
  it('ejecuta la herramienta con la entrada del modelo y el contexto del servidor, y le devuelve el resultado', async () => {
    const search = fakeTool('buscar_servicios', [SEMI]);
    const first = callTools([{ name: 'buscar_servicios', input: { texto: 'semi' }, id: 'toolu_1' }]);
    const { run, requests } = agent([first, finalAnswer('Tengo el semi.')], [search.tool]);

    const { run: record } = await run();

    expect(search.run).toHaveBeenCalledWith({ texto: 'semi' }, toolContext);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual([
      ...HISTORY,
      { role: 'assistant_turn', turn: first.assistantTurn },
      {
        role: 'tool_results',
        results: [{ toolCallId: 'toolu_1', content: JSON.stringify({ servicios: ['Semipermanente'] }), isError: false }],
      },
    ]);
    expect(record).toMatchObject({ llmCalls: 2, toolCalls: ['buscar_servicios'], outcome: 'replied' });
  });

  it('el turno del asistente se reenvía intacto: es el mismo objeto que devolvió el modelo', async () => {
    const search = fakeTool('buscar_servicios');
    const first = callTools([{ name: 'buscar_servicios' }], { assistantTurn: { raw: { bloques: ['razonamiento', 'tool_use'] } } });
    const second = callTools([{ name: 'buscar_servicios' }]);
    const { run, requests } = agent([first, second, finalAnswer('Listo')], [search.tool]);

    await run();

    const turns = requests[2]?.messages.filter((message) => message.role === 'assistant_turn');
    expect(turns).toHaveLength(2);
    expect(turns?.[0] && 'turn' in turns[0] && turns[0].turn).toBe(first.assistantTurn);
    expect(turns?.[1] && 'turn' in turns[1] && turns[1].turn).toBe(second.assistantTurn);
  });

  it('varias herramientas en un mismo turno: todos los resultados vuelven juntos, en el orden pedido', async () => {
    const search = fakeTool('buscar_servicios', [SEMI]);
    const info = fakeTool('consultar_informacion');
    const first = callTools([
      { name: 'buscar_servicios', id: 'toolu_a' },
      { name: 'consultar_informacion', id: 'toolu_b' },
    ]);
    const { run, requests } = agent([first, finalAnswer('Todo')], [search.tool, info.tool]);

    await run();

    const toolMessages = requests[1]?.messages.filter((message) => message.role === 'tool_results');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages?.[0]).toMatchObject({
      results: [{ toolCallId: 'toolu_a' }, { toolCallId: 'toolu_b' }],
    });
  });

  it('una entrada inválida vuelve como error para que el modelo la corrija', async () => {
    const search = fakeTool('buscar_servicios');
    const first = callTools([{ name: 'buscar_servicios', input: { texto: '' }, id: 'toolu_1' }]);
    const { run, requests } = agent([first, finalAnswer('Perdón, ¿qué servicio buscás?')], [search.tool]);

    await run();

    expect(search.run).not.toHaveBeenCalled();
    const results = requests[1]?.messages.at(-1);
    expect(results).toMatchObject({
      role: 'tool_results',
      results: [{ toolCallId: 'toolu_1', isError: true, content: expect.stringContaining('Entrada inválida') as unknown }],
    });
  });

  it('una herramienta que no existe vuelve como error y no corta la vuelta', async () => {
    const first = callTools([{ name: 'reservar_turno', id: 'toolu_1' }]);
    const { run, requests } = agent([first, finalAnswer('No puedo hacer eso.')]);

    const { message } = await run();

    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool_results',
      results: [{ toolCallId: 'toolu_1', isError: true, content: expect.stringContaining('reservar_turno') as unknown }],
    });
    expect(message).toEqual({ type: 'text', body: 'No puedo hacer eso.' });
  });

  it('un resultado que la herramienta marca como error llega al modelo con isError', async () => {
    const failing: AgentTool<unknown> = {
      name: 'consultar_disponibilidad',
      description: 'Falla siempre.',
      input: z.object({}),
      run: () => Promise.resolve({ content: { error: 'Servicio no encontrado' }, options: [], isError: true }),
    };
    const first = callTools([{ name: 'consultar_disponibilidad', id: 'toolu_1' }]);
    const { run, requests } = agent([first, finalAnswer('No encontré ese servicio.')], [failing]);

    await run();

    expect(requests[1]?.messages.at(-1)).toMatchObject({ results: [{ isError: true }] });
  });

  it('si una herramienta falla de verdad (la base no responde), el error sube y la tarea se reintenta', async () => {
    const broken: AgentTool<unknown> = {
      name: 'buscar_servicios',
      description: 'Rota.',
      input: z.object({}),
      run: () => Promise.reject(new Error('conexión caída')),
    };
    const { run } = agent([callTools([{ name: 'buscar_servicios' }])], [broken]);

    await expect(run()).rejects.toThrow('conexión caída');
  });
});

describe('runAgent: tope de llamadas a herramientas (9.1)', () => {
  const loopingModel = (): ScriptStep[] => [
    ...Array.from({ length: MAX_TOOL_CALLS_PER_REPLY }, () => callTools([{ name: 'buscar_servicios' }])),
    finalAnswer('Esto es lo que encontré.'),
  ];

  it('el tope es de 8', () => {
    expect(MAX_TOOL_CALLS_PER_REPLY).toBe(8);
  });

  it('al llegar al tope, la última llamada al modelo es sin herramientas', async () => {
    const search = fakeTool('buscar_servicios');
    const { run, requests } = agent(loopingModel(), [search.tool]);

    const { message, run: record } = await run();

    expect(search.run).toHaveBeenCalledTimes(8);
    expect(requests).toHaveLength(9);
    expect(requests.slice(0, 8).every((request) => request.allowTools)).toBe(true);
    expect(requests[8]?.allowTools).toBe(false);
    // La lista de herramientas se manda igual: así no se invalida la caché.
    expect(requests[8]?.tools).toEqual(requests[0]?.tools);
    expect(message).toEqual({ type: 'text', body: 'Esto es lo que encontré.' });
    expect(record).toMatchObject({ outcome: 'tool_limit', llmCalls: 9 });
    expect(record.toolCalls).toHaveLength(8);
  });

  it('si el modelo pide más herramientas de las que quedan, las que sobran vuelven como error sin ejecutarse', async () => {
    const search = fakeTool('buscar_servicios');
    const script: ScriptStep[] = [
      ...Array.from({ length: 7 }, () => callTools([{ name: 'buscar_servicios' }])),
      callTools([
        { name: 'buscar_servicios', id: 'toolu_ok' },
        { name: 'buscar_servicios', id: 'toolu_extra1' },
        { name: 'buscar_servicios', id: 'toolu_extra2' },
      ]),
      finalAnswer('Listo.'),
    ];
    const { run, requests } = agent(script, [search.tool]);

    const { run: record } = await run();

    expect(search.run).toHaveBeenCalledTimes(8);
    expect(requests.at(-1)?.messages.at(-1)).toMatchObject({
      results: [
        { toolCallId: 'toolu_ok', isError: false },
        { toolCallId: 'toolu_extra1', isError: true },
        { toolCallId: 'toolu_extra2', isError: true },
      ],
    });
    expect(record.toolCalls).toHaveLength(8);
    expect(record.outcome).toBe('tool_limit');
  });

  it('un modelo que se porta bien no toca el tope', async () => {
    const search = fakeTool('buscar_servicios');
    const { run } = agent([callTools([{ name: 'buscar_servicios' }]), finalAnswer('Listo')], [search.tool]);

    expect((await run()).run.outcome).toBe('replied');
  });
});

describe('runAgent: las opciones (6.4, 8.1)', () => {
  const searchOffering = (...options: OfferableOption[]) => fakeTool('buscar_servicios', options);

  function answerWithOptions(options: OfferableOption[], opciones: string[], texto = '¿Cuál te interesa?') {
    const search = searchOffering(...options);
    return agent(
      [callTools([{ name: 'buscar_servicios' }]), finalAnswer(texto, opciones)],
      [search.tool],
    );
  }

  it('con hasta 3 opciones armadas como botones, con el título y el id que dio la herramienta', async () => {
    const { run } = answerWithOptions([SEMI, ESCULPIDAS], [SEMI.id, ESCULPIDAS.id]);

    const { message } = await run();

    expect(message).toEqual({
      type: 'buttons',
      body: '¿Cuál te interesa?',
      buttons: [
        { id: 'servicio:semi', title: 'Semipermanente' },
        { id: 'servicio:esculpidas', title: 'Uñas esculpidas' },
      ],
    });
  });

  it('respeta el orden en que el modelo las eligió, aunque la herramienta las haya devuelto en otro', async () => {
    const { run } = answerWithOptions([SEMI, ESCULPIDAS, PIES], [PIES.id, SEMI.id]);

    const { message } = await run();

    expect(message).toMatchObject({ buttons: [{ id: PIES.id }, { id: SEMI.id }] });
  });

  it('un id que ninguna herramienta ofreció en esta vuelta se descarta', async () => {
    const { run } = answerWithOptions([SEMI], [SEMI.id, 'servicio:inventado', 'horario:otro-negocio']);

    const { message } = await run();

    expect(message).toMatchObject({ type: 'buttons', buttons: [{ id: SEMI.id }] });
  });

  it('si no queda ninguna opción válida, contesta solo con el texto', async () => {
    const { run } = answerWithOptions([SEMI], ['servicio:inventado']);

    const { message } = await run();

    expect(message).toEqual({ type: 'text', body: '¿Cuál te interesa?' });
  });

  it('un id repetido se ofrece una sola vez', async () => {
    const { run } = answerWithOptions([SEMI, ESCULPIDAS], [SEMI.id, SEMI.id, ESCULPIDAS.id]);

    const { message } = await run();

    expect(message).toMatchObject({ buttons: [{ id: SEMI.id }, { id: ESCULPIDAS.id }] });
  });

  it('las opciones de una herramienta anterior de la misma vuelta también valen', async () => {
    const first = searchOffering(SEMI);
    const second = fakeTool('consultar_disponibilidad', [{ id: 'horario:1', title: 'lun 5/10 9:00' }]);
    const { run } = agent(
      [
        callTools([{ name: 'buscar_servicios' }]),
        callTools([{ name: 'consultar_disponibilidad' }]),
        finalAnswer('Elegí', [SEMI.id, 'horario:1']),
      ],
      [first.tool, second.tool],
    );

    const { message } = await run();

    expect(message).toMatchObject({ buttons: [{ id: SEMI.id }, { id: 'horario:1' }] });
  });

  it('un id que el modelo copia de un mensaje viejo del historial no vale: sin herramienta en esta vuelta no hay opciones', async () => {
    const { run } = agent([finalAnswer('Tenés estas opciones', ['servicio:semi'])]);

    const { message } = await run();

    expect(message).toEqual({ type: 'text', body: 'Tenés estas opciones' });
  });

  it('más de 3 opciones se arman como lista, con el botón "Ver opciones"', async () => {
    const many: OfferableOption[] = [SEMI, ESCULPIDAS, PIES, { id: 'servicio:cuarto', title: 'Cuarto servicio' }];
    const { run } = answerWithOptions(many, many.map((option) => option.id));

    const { message } = await run();

    expect(message).toEqual({
      type: 'list',
      body: '¿Cuál te interesa?',
      buttonLabel: 'Ver opciones',
      sections: [
        {
          rows: [
            { id: 'servicio:semi', title: 'Semipermanente', description: '60 min' },
            { id: 'servicio:esculpidas', title: 'Uñas esculpidas' },
            { id: 'servicio:pies', title: 'Semi en pies' },
            { id: 'servicio:cuarto', title: 'Cuarto servicio' },
          ],
        },
      ],
    });
  });

  it('una lista tiene como máximo 10 filas', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ id: `servicio:${String(index)}`, title: `Servicio ${String(index)}` }));
    const { run } = answerWithOptions(many, many.map((option) => option.id));

    const { message } = await run();

    expect(message.type === 'list' && message.sections[0]?.rows).toHaveLength(10);
  });

  it('un título de más de 20 caracteres no entra en un botón: va como lista, con el título acortado a 24', async () => {
    const long: OfferableOption = { id: 'servicio:largo', title: 'Esmaltado semipermanente con diseño' };
    const { run } = answerWithOptions([long, SEMI], [long.id, SEMI.id]);

    const { message } = await run();

    expect(message.type).toBe('list');
    const titles = message.type === 'list' ? message.sections.flatMap((s) => s.rows.map((row) => row.title)) : [];
    expect(titles.every((title) => title.length <= 24)).toBe(true);
    expect(titles[0]).toBe('Esmaltado…');
  });

  it('un texto de más de 1024 caracteres no entra en el cuerpo de un botón: va como lista', async () => {
    const { run } = answerWithOptions([SEMI], [SEMI.id], 'a'.repeat(1_500));

    const { message } = await run();

    expect(message).toMatchObject({ type: 'list', buttonLabel: 'Ver opciones' });
  });

  it('una descripción de más de 72 caracteres se acorta en la lista', async () => {
    const many: OfferableOption[] = [
      { id: 'a', title: 'Uno', description: 'x'.repeat(100) },
      { id: 'b', title: 'Dos' },
      { id: 'c', title: 'Tres' },
      { id: 'd', title: 'Cuatro' },
    ];
    const { run } = answerWithOptions(many, ['a', 'b', 'c', 'd']);

    const { message } = await run();

    const description = message.type === 'list' ? message.sections[0]?.rows[0]?.description : undefined;
    expect(description).toHaveLength(72);
  });

  it('si las opciones no arman un mensaje que WhatsApp acepte, contesta solo con el texto', async () => {
    // El id de un botón puede tener hasta 256 caracteres (outgoing.ts).
    const tooLong: OfferableOption = { id: `servicio:${'x'.repeat(300)}`, title: 'Largo' };
    const { run } = answerWithOptions([tooLong], [tooLong.id]);

    const { message } = await run();

    expect(message).toEqual({ type: 'text', body: '¿Cuál te interesa?' });
  });
});

describe('runAgent: cuando el modelo no da una respuesta que se pueda usar', () => {
  const cases: [string, ScriptStep, string][] = [
    ['el proveedor se negó a contestar', finalAnswer('No', [], { stopReason: 'refusal' }), 'fallback_refusal'],
    ['la respuesta se cortó por el largo máximo', finalAnswer('Hola', [], { stopReason: 'max_tokens' }), 'fallback_max_tokens'],
    ['la salida no es JSON', rawAnswer('Hola, ¿cómo estás?'), 'fallback_invalid_output'],
    ['falta el texto', rawAnswer(JSON.stringify({ opciones: [] })), 'fallback_invalid_output'],
    ['el texto está vacío', rawAnswer(JSON.stringify({ texto: '   ', opciones: [] })), 'fallback_invalid_output'],
    ['las opciones no son una lista de textos', rawAnswer(JSON.stringify({ texto: 'Hola', opciones: [1] })), 'fallback_invalid_output'],
  ];

  it.each(cases)('%s: contesta la frase fija y lo registra', async (_name, step, outcome) => {
    const { run } = agent([step]);

    const { message, run: record } = await run();

    expect(message).toEqual({ type: 'text', body: FALLBACK_REPLY_TEXT });
    expect(record.outcome).toBe(outcome);
  });

  it('la frase fija es la que aprobó el equipo', () => {
    expect(FALLBACK_REPLY_TEXT).toBe('Perdón, no te entendí bien. ¿Me lo escribís de otra forma?');
  });

  it('una respuesta cortada que pedía herramientas no ejecuta nada', async () => {
    const search = fakeTool('buscar_servicios');
    const truncated = callTools([{ name: 'buscar_servicios' }], { stopReason: 'max_tokens' });
    const { run } = agent([truncated], [search.tool]);

    const { run: record } = await run();

    expect(search.run).not.toHaveBeenCalled();
    expect(record.outcome).toBe('fallback_max_tokens');
  });

  it('la salida inválida después del tope también cae a la frase fija', async () => {
    const search = fakeTool('buscar_servicios');
    const script: ScriptStep[] = [
      ...Array.from({ length: 8 }, () => callTools([{ name: 'buscar_servicios' }])),
      rawAnswer('texto suelto'),
    ];
    const { run } = agent(script, [search.tool]);

    const { message, run: record } = await run();

    expect(message).toEqual({ type: 'text', body: FALLBACK_REPLY_TEXT });
    expect(record.outcome).toBe('fallback_invalid_output');
  });
});

describe('runAgent: el registro de la vuelta', () => {
  it('suma los tokens de todas las llamadas, anota las herramientas en orden y mide la latencia', async () => {
    const search = fakeTool('buscar_servicios');
    const info = fakeTool('consultar_informacion');
    const script: ScriptStep[] = [
      callTools([{ name: 'buscar_servicios' }, { name: 'consultar_informacion' }], {
        usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 800 },
        model: 'modelo-a',
      }),
      finalAnswer('Listo', [], {
        usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 800, cacheWriteTokens: 0 },
        model: 'modelo-b',
      }),
    ];
    const { llm } = scriptedLlm(script);
    let clock = 1_000;
    const ticks = [1_000, 1_450];
    const monotonicNow = () => ticks.shift() ?? (clock += 1);

    const { run: record } = await runAgent(
      { llm, tools: [search.tool, info.tool], logger, monotonicNow },
      { system: 'S', turnContext: 'C', history: HISTORY, toolContext },
    );

    expect(record).toEqual({
      model: 'modelo-b',
      llmCalls: 2,
      usage: { inputTokens: 1_200, outputTokens: 80, cacheReadTokens: 800, cacheWriteTokens: 800 },
      toolCalls: ['buscar_servicios', 'consultar_informacion'],
      latencyMs: 450,
      outcome: 'replied',
    });
  });
});

describe('runAgent: cancelación', () => {
  it('si la tarea ya se canceló, no llama al modelo', async () => {
    const controller = new AbortController();
    controller.abort(new Error('tiempo agotado'));
    const { run, requests } = agent([finalAnswer('Hola')]);

    await expect(run({ toolContext: { ...toolContext, signal: controller.signal } })).rejects.toThrow('tiempo agotado');
    expect(requests).toHaveLength(0);
  });

  it('si se cancela mientras corren las herramientas, no vuelve a llamar al modelo', async () => {
    const controller = new AbortController();
    const slow: AgentTool<unknown> = {
      name: 'buscar_servicios',
      description: 'Lenta.',
      input: z.object({}),
      run: () => {
        controller.abort(new Error('tiempo agotado'));
        return Promise.resolve({ content: {}, options: [] });
      },
    };
    const { run, requests } = agent([callTools([{ name: 'buscar_servicios' }]), finalAnswer('Hola')], [slow]);

    await expect(run({ toolContext: { ...toolContext, signal: controller.signal } })).rejects.toThrow('tiempo agotado');
    expect(requests).toHaveLength(1);
  });

  it('le pasa la señal al modelo para cortar la llamada en curso', async () => {
    const controller = new AbortController();
    const { run, requests } = agent([finalAnswer('Hola')]);

    await run({ toolContext: { ...toolContext, signal: controller.signal } });

    expect(requests[0]?.signal).toBe(controller.signal);
  });
});
