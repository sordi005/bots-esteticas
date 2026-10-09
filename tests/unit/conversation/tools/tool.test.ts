import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  runTool,
  type AgentTool,
  type ToolContext,
} from '../../../../src/modules/conversation/tools/tool.js';

const context: ToolContext = {
  db: drizzle.mock(),
  tenantId: '00000000-0000-4000-8000-000000000001',
  customerId: '00000000-0000-4000-8000-000000000002',
  now: new Date('2026-10-04T12:00:00.000Z'),
  timeZone: 'America/Argentina/Mendoza',
  signal: new AbortController().signal,
};

function echoTool() {
  const run = vi.fn((input: { texto: string }, ctx: ToolContext) =>
    Promise.resolve({
      content: { texto: input.texto, negocio: ctx.tenantId },
      options: [{ id: 'servicio:x', title: 'Semi' }],
    }),
  );
  const tool: AgentTool<{ texto: string }> = {
    name: 'eco',
    description: 'Repite el texto.',
    input: z.object({ texto: z.string().trim().min(1, 'Falta el texto') }),
    run,
  };
  return { tool, run };
}

describe('runTool: valida la entrada del modelo antes de ejecutar la herramienta', () => {
  it('ejecuta la herramienta con la entrada ya validada y el contexto del servidor', async () => {
    const { tool, run } = echoTool();

    const result = await runTool(tool, { texto: '  hola  ' }, context);

    expect(result.content).toEqual({ texto: 'hola', negocio: context.tenantId });
    expect(result.options).toEqual([{ id: 'servicio:x', title: 'Semi' }]);
    expect(run).toHaveBeenCalledWith({ texto: 'hola' }, context);
  });

  it('el negocio y la clienta salen del contexto: lo que el modelo mande de más no llega (6.4)', async () => {
    const { tool, run } = echoTool();

    await runTool(
      tool,
      { texto: 'hola', tenant_id: 'otro-negocio', tenantId: 'otro', customer_id: 'otra-clienta' },
      context,
    );

    expect(run).toHaveBeenCalledWith({ texto: 'hola' }, context);
  });

  it('una entrada inválida no ejecuta la herramienta y vuelve como error que el modelo puede leer', async () => {
    const { tool, run } = echoTool();

    const result = await runTool(tool, { texto: '   ' }, context);

    expect(run).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.options).toEqual([]);
    expect(result.content).toEqual({
      error: 'Entrada inválida',
      detalles: ['texto: Falta el texto'],
    });
  });

  it('una entrada de otro tipo (no es un objeto) también es un error de entrada', async () => {
    const { tool, run } = echoTool();

    const result = await runTool(tool, 'hola', context);

    expect(run).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: 'Entrada inválida' });
  });

  it('lista todos los problemas de la entrada, cada uno con su campo', async () => {
    const tool: AgentTool<{ a: string; b: number }> = {
      name: 'dos_campos',
      description: 'Pide dos campos.',
      input: z.object({ a: z.string(), b: z.number().int() }),
      run: () => Promise.resolve({ content: {}, options: [] }),
    };

    const result = await runTool(tool, { a: 1, b: 1.5 }, context);

    const { detalles } = result.content as { detalles: string[] };
    expect(detalles).toHaveLength(2);
    expect(detalles.map((detail) => detail.split(':')[0])).toEqual(['a', 'b']);
  });

  it('un error de la herramienta (no de la entrada) no se disfraza: se propaga', async () => {
    const tool: AgentTool<Record<string, never>> = {
      name: 'rota',
      description: 'Falla.',
      input: z.object({}),
      run: () => Promise.reject(new Error('la base no responde')),
    };

    await expect(runTool(tool, {}, context)).rejects.toThrow('la base no responde');
  });
});
