import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { consultationTools } from '../../../../src/modules/conversation/tools/index.js';

interface ObjectSchema {
  type: string;
  properties: Record<string, { description?: string }>;
  required?: string[];
}

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
