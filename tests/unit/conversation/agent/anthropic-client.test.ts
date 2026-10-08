import { APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAnthropicLlmClient,
  toStrictSchema,
} from '../../../../src/modules/conversation/agent/anthropic-client.js';
import { consultationTools } from '../../../../src/modules/conversation/tools/index.js';
import type { LlmRequest } from '../../../../src/modules/conversation/agent/llm-client.js';

const TEST_API_KEY = 'sk-ant-clave-de-prueba';

/** Una respuesta de la API con la forma documentada de /v1/messages. */
function apiMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: '{"texto":"Hola","opciones":[]}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1200,
      cache_creation_input_tokens: 800,
      cache_read_input_tokens: 0,
      output_tokens: 60,
      service_tier: 'standard',
    },
    ...overrides,
  };
}

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

/** `fetch` de mentira: anota cada pedido y contesta con lo guionado (la última respuesta se repite). */
function fakeFetch(responses: (Record<string, unknown> | Response)[]) {
  const calls: Captured[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
      signal: init?.signal,
    });
    const next = responses[Math.min(calls.length, responses.length) - 1];
    if (!next) throw new Error('Sin respuesta guionada');
    return Promise.resolve(
      next instanceof Response
        ? next
        : new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
  return { fetch: impl, calls };
}

const client = (fetchImpl: typeof fetch, model = 'claude-haiku-5-5') =>
  createAnthropicLlmClient({ apiKey: TEST_API_KEY, model, fetch: fetchImpl });

const SEARCH_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { texto: { type: 'string', maxLength: 200, description: 'Lo que pide la clienta.' } },
};
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: { texto: { type: 'string' }, opciones: { type: 'array', items: { type: 'string' } } },
  required: ['texto', 'opciones'],
  additionalProperties: false,
};

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    system: 'Sos Luna.',
    turnContext: 'Contexto del sistema (no lo escribió la clienta): hoy es lunes.',
    messages: [{ role: 'user', text: '¿Cuánto sale el semi?' }],
    tools: [{ name: 'buscar_servicios', description: 'Busca servicios.', inputSchema: SEARCH_SCHEMA }],
    responseSchema: RESPONSE_SCHEMA,
    allowTools: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('createAnthropicLlmClient: el pedido que se manda a la API', () => {
  it('manda el cuerpo completo de una llamada típica', async () => {
    const { fetch, calls } = fakeFetch([apiMessage()]);

    await client(fetch).complete(request());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers.get('x-api-key')).toBe(TEST_API_KEY);
    expect(calls[0]?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(calls[0]?.body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 4_096,
      system: [{ type: 'text', text: 'Sos Luna.', cache_control: { type: 'ephemeral' } }],
      tools: [
        {
          name: 'buscar_servicios',
          description: 'Busca servicios.',
          strict: true,
          input_schema: {
            type: 'object',
            properties: { texto: { type: 'string', description: 'Lo que pide la clienta.' } },
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'auto' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
      messages: [
        { role: 'user', content: '¿Cuánto sale el semi?' },
        { role: 'system', content: 'Contexto del sistema (no lo escribió la clienta): hoy es lunes.' },
      ],
    });
  });

  it('usa el modelo que se le configuró', async () => {
    const { fetch, calls } = fakeFetch([apiMessage()]);

    await client(fetch, 'claude-sonnet-5-5').complete(request());

    expect(calls[0]?.body).toMatchObject({ model: 'claude-sonnet-5-5' });
  });

  it('sin permiso para herramientas pide tool_choice none y manda la misma lista, para no romper la caché', async () => {
    const { fetch, calls } = fakeFetch([apiMessage(), apiMessage()]);

    await client(fetch).complete(request({ allowTools: true }));
    await client(fetch).complete(request({ allowTools: false }));

    expect(calls[0]?.body.tool_choice).toEqual({ type: 'auto' });
    expect(calls[1]?.body.tool_choice).toEqual({ type: 'none' });
    expect(calls[1]?.body.tools).toEqual(calls[0]?.body.tools);
  });

  it('no manda thinking, temperatura ni tool_choice forzado: Haiku 5.5 razona solo y los rechaza', async () => {
    const { fetch, calls } = fakeFetch([apiMessage()]);

    await client(fetch).complete(request());

    const body = calls[0]?.body ?? {};
    for (const key of ['thinking', 'temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(key);
    expect(JSON.stringify(body.tool_choice)).not.toMatch(/"any"|"tool"/);
  });

  it('el contexto de la vuelta va como mensaje de sistema justo después del último mensaje de la clienta', async () => {
    const { fetch, calls } = fakeFetch([apiMessage()]);

    await client(fetch).complete(
      request({
        messages: [
          { role: 'user', text: 'Hola' },
          { role: 'assistant', text: 'Hola, soy Luna.' },
          { role: 'user', text: 'Quiero un semi' },
          { role: 'user', text: 'para el viernes' },
        ],
      }),
    );

    expect(calls[0]?.body.messages).toEqual([
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: 'Hola, soy Luna.' },
      { role: 'user', content: 'Quiero un semi' },
      { role: 'user', content: 'para el viernes' },
      { role: 'system', content: expect.stringContaining('Contexto del sistema') as unknown },
    ]);
  });

  it('sin contexto no agrega ningún mensaje de sistema', async () => {
    const { fetch, calls } = fakeFetch([apiMessage()]);

    await client(fetch).complete(request({ turnContext: '' }));

    expect(calls[0]?.body.messages).toEqual([{ role: 'user', content: '¿Cuánto sale el semi?' }]);
  });
});

describe('createAnthropicLlmClient: el ciclo de herramientas', () => {
  const thinkingBlock = { type: 'thinking', thinking: '', signature: 'EqQBCkYIAxgCKkBfirma-opaca' };
  const toolUseBlock = {
    type: 'tool_use',
    id: 'toolu_01A09q90qw90lq917835lq9',
    name: 'buscar_servicios',
    input: { texto: 'semi' },
    caller: { type: 'direct' },
  };

  it('devuelve las llamadas a herramientas, el uso de tokens y el modelo', async () => {
    const { fetch } = fakeFetch([
      apiMessage({ content: [thinkingBlock, toolUseBlock], stop_reason: 'tool_use' }),
    ]);

    const response = await client(fetch).complete(request());

    expect(response).toMatchObject({
      toolCalls: [{ id: 'toolu_01A09q90qw90lq917835lq9', name: 'buscar_servicios', input: { texto: 'semi' } }],
      stopReason: 'tool_calls',
      model: 'claude-haiku-5-5',
      usage: { inputTokens: 1_200, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 800 },
      text: '',
    });
  });

  it('la entrada de la herramienta llega sin validar, tal como la escribió el modelo', async () => {
    const { fetch } = fakeFetch([
      apiMessage({ content: [{ ...toolUseBlock, input: { texto: 5, de_mas: true } }], stop_reason: 'tool_use' }),
    ]);

    const response = await client(fetch).complete(request());

    expect(response.toolCalls[0]?.input).toEqual({ texto: 5, de_mas: true });
  });

  it('reenvía el turno del asistente intacto (con el bloque de razonamiento) y los resultados juntos en un solo mensaje', async () => {
    const turnContent = [thinkingBlock, toolUseBlock, { ...toolUseBlock, id: 'toolu_02', name: 'consultar_informacion' }];
    const { fetch, calls } = fakeFetch([
      apiMessage({ content: turnContent, stop_reason: 'tool_use' }),
      apiMessage(),
    ]);
    const llm = client(fetch);

    const first = await llm.complete(request());
    await llm.complete(
      request({
        messages: [
          { role: 'user', text: '¿Cuánto sale el semi?' },
          { role: 'assistant_turn', turn: first.assistantTurn },
          {
            role: 'tool_results',
            results: [
              { toolCallId: 'toolu_01A09q90qw90lq917835lq9', content: '{"servicios":[]}', isError: false },
              { toolCallId: 'toolu_02', content: '{"error":"Tema inválido"}', isError: true },
            ],
          },
        ],
      }),
    );

    expect(calls[1]?.body.messages).toEqual([
      { role: 'user', content: '¿Cuánto sale el semi?' },
      { role: 'system', content: expect.stringContaining('Contexto del sistema') as unknown },
      { role: 'assistant', content: turnContent },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01A09q90qw90lq917835lq9', content: '{"servicios":[]}', is_error: false },
          { type: 'tool_result', tool_use_id: 'toolu_02', content: '{"error":"Tema inválido"}', is_error: true },
        ],
      },
    ]);
  });

  it('el mensaje de sistema queda antes del turno del asistente de la vuelta, no entre la herramienta y su resultado', async () => {
    const { fetch, calls } = fakeFetch([apiMessage({ content: [toolUseBlock], stop_reason: 'tool_use' }), apiMessage()]);
    const llm = client(fetch);
    const first = await llm.complete(request());

    await llm.complete(
      request({
        messages: [
          { role: 'user', text: 'Hola' },
          { role: 'assistant_turn', turn: first.assistantTurn },
          { role: 'tool_results', results: [{ toolCallId: toolUseBlock.id, content: '{}', isError: false }] },
        ],
      }),
    );

    const roles = (calls[1]?.body.messages as { role: string }[]).map((message) => message.role);
    expect(roles).toEqual(['user', 'system', 'assistant', 'user']);
  });
});

describe('createAnthropicLlmClient: la respuesta final y sus motivos de fin', () => {
  it('une los bloques de texto de la respuesta final', async () => {
    const { fetch } = fakeFetch([
      apiMessage({
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: '{"texto":"Hola",' },
          { type: 'text', text: '"opciones":[]}' },
        ],
      }),
    ]);

    const response = await client(fetch).complete(request());

    expect(response).toMatchObject({ text: '{"texto":"Hola","opciones":[]}', stopReason: 'end', toolCalls: [] });
  });

  it.each([
    ['end_turn', 'end'],
    ['stop_sequence', 'end'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['pause_turn', 'other'],
    ['model_context_window_exceeded', 'other'],
  ])('el motivo %s de la API es %s', async (apiReason, expected) => {
    const { fetch } = fakeFetch([apiMessage({ stop_reason: apiReason })]);

    expect((await client(fetch).complete(request())).stopReason).toBe(expected);
  });

  it('una negativa del proveedor llega como refusal con el detalle, sin error', async () => {
    const { fetch } = fakeFetch([
      apiMessage({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'general_harms', explanation: 'x' },
      }),
    ]);

    const response = await client(fetch).complete(request());

    expect(response).toMatchObject({ stopReason: 'refusal', text: '', toolCalls: [] });
  });

  it('si la API no informa la caché, cuenta cero tokens en vez de NaN', async () => {
    const { fetch } = fakeFetch([
      apiMessage({ usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null } }),
    ]);

    expect((await client(fetch).complete(request())).usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe('createAnthropicLlmClient: errores, reintentos y cancelación', () => {
  const errorResponse = (status: number, type: string) =>
    new Response(JSON.stringify({ type: 'error', error: { type, message: 'falló' } }), {
      status,
      // Evita la espera entre reintentos en los tests.
      headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
    });

  it('los errores del proveedor suben tal cual: no se disfrazan de respuesta', async () => {
    const { fetch } = fakeFetch([errorResponse(401, 'authentication_error')]);

    const failure = await client(fetch)
      .complete(request())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(APIError);
    expect((failure as APIError).status).toBe(401);
  });

  it('reintenta una sola vez ante un error del servidor', async () => {
    const { fetch, calls } = fakeFetch([errorResponse(500, 'api_error'), apiMessage()]);

    const response = await client(fetch).complete(request());

    expect(calls).toHaveLength(2);
    expect(response.stopReason).toBe('end');
  });

  it('si el reintento también falla, sube el error después de 2 llamadas en total', async () => {
    const { fetch, calls } = fakeFetch([errorResponse(529, 'overloaded_error')]);

    await expect(client(fetch).complete(request())).rejects.toBeInstanceOf(APIError);
    expect(calls).toHaveLength(2);
  });

  it('un error del pedido (400) no se reintenta', async () => {
    const { fetch, calls } = fakeFetch([errorResponse(400, 'invalid_request_error')]);

    await expect(client(fetch).complete(request())).rejects.toBeInstanceOf(APIError);
    expect(calls).toHaveLength(1);
  });

  it('la señal de la tarea llega a la llamada: al cancelarla se corta el pedido en curso', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Un pedido que nunca termina, salvo que lo corten.
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        started();
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Cortado', 'AbortError'));
        });
      });

    const pending = client(hanging)
      .complete(request({ signal: controller.signal }))
      .catch((error: unknown) => error);
    await inFlight;
    controller.abort();

    expect(await pending).toBeInstanceOf(APIUserAbortError);
  });
});

describe('toStrictSchema: los esquemas de Zod pasan a lo que aceptan las herramientas estrictas', () => {
  it('saca $schema y los mínimos y máximos que la API rechaza, y cierra los objetos', () => {
    const result = toStrictSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        nombre: { type: 'string', minLength: 1, maxLength: 20, description: 'Nombre.' },
        cantidad: { type: 'integer', minimum: 1, maximum: 10 },
        lista: { type: 'array', items: { type: 'string', maxLength: 5 }, minItems: 1, maxItems: 3 },
      },
      required: ['nombre'],
    });

    expect(result).toEqual({
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre.' },
        cantidad: { type: 'integer' },
        lista: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['nombre'],
      additionalProperties: false,
    });
  });

  it('quita el pattern cuando ya hay un format soportado (uuid, date-time): el regex de Zod es demasiado complejo', () => {
    const result = toStrictSchema({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', pattern: '^(?:[0-9a-f]{8}-(?=x))$' },
        fecha: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
    });

    expect(result).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        fecha: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    });
  });

  it('cierra también los objetos anidados y no toca el esquema original', () => {
    const original = {
      type: 'object',
      properties: { dentro: { type: 'object', properties: { x: { type: 'string', maxLength: 3 } } } },
    };
    const snapshot = structuredClone(original);

    const result = toStrictSchema(original);

    expect(result).toEqual({
      type: 'object',
      properties: {
        dentro: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false },
      },
      additionalProperties: false,
    });
    expect(original).toEqual(snapshot);
  });

  it('un enum se conserva tal cual', () => {
    const result = toStrictSchema({
      type: 'object',
      properties: { tema: { type: 'string', enum: ['direccion', 'horarios'] } },
      required: ['tema'],
    });

    expect(result).toMatchObject({ properties: { tema: { enum: ['direccion', 'horarios'] } } });
  });

  it('los esquemas de las herramientas de H7 quedan aceptables para strict: sin restricciones ni regex complejos y dentro de los límites', () => {
    let optional = 0;
    for (const tool of consultationTools) {
      const schema = toStrictSchema(z.toJSONSchema(tool.input, { io: 'input' }));
      const text = JSON.stringify(schema);

      expect(text, tool.name).not.toMatch(/\$schema|minLength|maxLength|"minimum"|"maximum"|\(\?[=!<]/);
      expect(schema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
      const properties = Object.keys((schema.properties ?? {}));
      optional += properties.length - ((schema.required ?? []) as string[]).length;
    }

    // La API admite hasta 24 parámetros opcionales entre todas las herramientas estrictas.
    expect(optional).toBeLessThanOrEqual(24);
    expect(consultationTools.length).toBeLessThanOrEqual(20);
  });
});
