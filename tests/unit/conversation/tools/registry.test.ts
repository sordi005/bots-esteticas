import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentTools, consultationTools } from '../../../../src/modules/conversation/tools/index.js';

interface ObjectSchema {
  type: string;
  properties: Record<string, { description?: string }>;
  required?: string[];
}

const agentSchemaOf = (name: string) => {
  const tool = agentTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No hay una herramienta ${name}`);
  return z.toJSONSchema(tool.input, { io: 'input' }) as unknown as ObjectSchema;
};

const schemaOf = (name: string) => {
  const tool = consultationTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No hay una herramienta ${name}`);
  return z.toJSONSchema(tool.input, { io: 'input' }) as unknown as ObjectSchema;
};

describe('consultationTools: las herramientas de consulta de H7', () => {
  it('tienen los nombres en español de la especificación (6.4)', () => {
    expect(consultationTools.map((tool) => tool.name)).toEqual([
      'buscar_servicios',
      'consultar_informacion',
      'consultar_disponibilidad',
    ]);
  });

  it('todas tienen una descripción para el modelo', () => {
    for (const tool of consultationTools) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it('los esquemas de entrada se pueden pasar a JSON Schema para el modelo', () => {
    expect(schemaOf('buscar_servicios')).toMatchObject({ type: 'object' });
    expect(Object.keys(schemaOf('consultar_informacion').properties)).toEqual(['tema']);
    expect(schemaOf('consultar_disponibilidad').required).toEqual(['servicio_id', 'desde', 'hasta']);
  });

  it('ninguna herramienta pide el negocio ni la clienta como parámetro (regla 2)', () => {
    for (const tool of consultationTools) {
      const properties = Object.keys(schemaOf(tool.name).properties).join(' ');
      expect(properties).not.toMatch(/tenant|negocio|customer|clienta|cliente/i);
    }
  });

  it('cada parámetro de consultar_disponibilidad le explica al modelo qué es', () => {
    const { properties } = schemaOf('consultar_disponibilidad');

    for (const [name, property] of Object.entries(properties)) {
      expect(property.description, name).toBeTruthy();
    }
  });
});

describe('agentTools: las herramientas que usa el agente', () => {
  it('son las de consulta y las de turnos (H8), con los nombres de la especificación (6.4): derivar no es una herramienta', () => {
    expect(agentTools.map((tool) => tool.name)).toEqual([
      ...consultationTools.map((tool) => tool.name),
      'crear_reserva',
      'listar_turnos_de_la_clienta',
      'reprogramar_turno',
      'cancelar_turno',
    ]);
  });

  it('todas tienen una descripción para el modelo y cada parámetro le explica qué es', () => {
    for (const tool of agentTools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      for (const [name, property] of Object.entries(agentSchemaOf(tool.name).properties)) {
        expect(property.description, `${tool.name}.${name}`).toBeTruthy();
      }
    }
  });

  it('crear_reserva pide el id del horario y, opcional, el nombre', () => {
    const schema = agentSchemaOf('crear_reserva');

    expect(Object.keys(schema.properties)).toEqual(['horario_id', 'nombre']);
    expect(schema.required).toEqual(['horario_id']);
  });

  it('listar_turnos_de_la_clienta no recibe nada: la clienta sale del contexto', () => {
    expect(Object.keys(agentSchemaOf('listar_turnos_de_la_clienta').properties)).toEqual([]);
  });

  it('cancelar_turno pide el turno y si la clienta confirmó; reprogramar_turno, el turno y el horario nuevo', () => {
    expect(Object.keys(agentSchemaOf('cancelar_turno').properties)).toEqual(['turno_id', 'confirmada']);
    expect(agentSchemaOf('cancelar_turno').required).toEqual(['turno_id', 'confirmada']);
    expect(Object.keys(agentSchemaOf('reprogramar_turno').properties)).toEqual(['turno_id', 'horario_id']);
    expect(agentSchemaOf('reprogramar_turno').required).toEqual(['turno_id', 'horario_id']);
  });

  it('ninguna herramienta nombra a derivar_a_persona: derivar va en el campo «derivar» de la respuesta (decisión 27)', () => {
    for (const tool of agentTools) {
      const text = `${tool.description} ${JSON.stringify(z.toJSONSchema(tool.input, { io: 'input' }))}`;
      expect(text, tool.name).not.toContain('derivar_a_persona');
    }
  });

  it('ninguna pide el negocio, la clienta ni la conversación como parámetro (regla 2)', () => {
    for (const tool of agentTools) {
      const schema = z.toJSONSchema(tool.input, { io: 'input' }) as unknown as ObjectSchema;
      expect(Object.keys(schema.properties).join(' '), tool.name).not.toMatch(
        /tenant|negocio|customer|clienta|cliente|conversa/i,
      );
    }
  });
});
