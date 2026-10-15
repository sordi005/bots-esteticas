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

  it('consultar_disponibilidad es solo para reservar: el servicio es obligatorio y no tiene turno_id (decisión 28)', () => {
    const { properties, required } = schemaOf('consultar_disponibilidad');
    const tool = consultationTools.find((candidate) => candidate.name === 'consultar_disponibilidad');

    expect(required).toContain('servicio_id');
    expect(Object.keys(properties)).toEqual(['servicio_id', 'profesional_id', 'desde', 'hasta', 'franja', 'despues_de']);
    expect(properties.servicio_id?.description).not.toMatch(/turno/i);
    expect(tool?.description).not.toMatch(/turno_id/);
    // Le dice adónde ir para mover un turno, sin mezclar los dos modos en una herramienta.
    expect(tool?.description).toMatch(/consultar_horarios_para_reprogramar/);
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
      'consultar_horarios_para_reprogramar',
      'consultar_hora',
      'consultar_hora_para_reprogramar',
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

  it('consultar_horarios_para_reprogramar pide el turno y las fechas, y no tiene servicio ni profesional', () => {
    const schema = agentSchemaOf('consultar_horarios_para_reprogramar');
    const tool = agentTools.find((candidate) => candidate.name === 'consultar_horarios_para_reprogramar');

    expect(Object.keys(schema.properties)).toEqual(['turno_id', 'desde', 'hasta', 'franja', 'despues_de']);
    expect(schema.required).toEqual(['turno_id', 'desde', 'hasta']);
    expect(schema.properties.turno_id?.description).toMatch(/listar_turnos_de_la_clienta/);
    expect(tool?.description).toMatch(/reprogramar_turno, no para crear_reserva/);
    expect(tool?.description).toMatch(/consultar_disponibilidad/);
  });

  it('consultar_hora pide el servicio, la fecha y la hora; la profesional es solo un filtro opcional (decisión 29)', () => {
    const schema = agentSchemaOf('consultar_hora');
    const tool = agentTools.find((candidate) => candidate.name === 'consultar_hora');

    expect(Object.keys(schema.properties)).toEqual(['servicio_id', 'profesional_id', 'fecha', 'hora']);
    expect(schema.required).toEqual(['servicio_id', 'fecha', 'hora']);
    expect(schema.properties.hora?.description).toMatch(/HH:MM/);
    expect(schema.properties.hora?.description).toMatch(/No la conviertas/);
    expect(schema.properties.fecha?.description).toMatch(/AAAA-MM-DD/);
    // Cuándo usarla, y que sale de lo que dice la herramienta (6.4).
    expect(tool?.description).toMatch(/hora puntual que no está entre las que ofreciste/);
    expect(tool?.description).toMatch(/Nunca digas que un horario está ocupado, que se ocupó o que no existe si esta herramienta no lo dijo/);
    expect(tool?.description).toMatch(/consultar_hora_para_reprogramar/);
    expect(tool?.description).not.toMatch(/turno_id/);
  });

  it('consultar_hora_para_reprogramar pide el turno, la fecha y la hora, y no tiene servicio ni profesional (decisión 29)', () => {
    const schema = agentSchemaOf('consultar_hora_para_reprogramar');
    const tool = agentTools.find((candidate) => candidate.name === 'consultar_hora_para_reprogramar');

    expect(Object.keys(schema.properties)).toEqual(['turno_id', 'fecha', 'hora']);
    expect(schema.required).toEqual(['turno_id', 'fecha', 'hora']);
    expect(schema.properties.turno_id?.description).toMatch(/listar_turnos_de_la_clienta/);
    expect(tool?.description).toMatch(/hora puntual que no está entre las que ofreciste para mover el turno/);
    expect(tool?.description).toMatch(/reprogramar_turno, no para crear_reserva/);
    expect(tool?.description).toMatch(/Nunca digas que un horario está ocupado, que se ocupó o que no existe si esta herramienta no lo dijo/);
    expect(tool?.description).toMatch(/consultar_hora\./);
  });

  it('las consultas de horarios mandan a la de hora puntual que les corresponde: reservar a consultar_hora y mover un turno a consultar_hora_para_reprogramar', () => {
    const reserve = agentTools.find((candidate) => candidate.name === 'consultar_disponibilidad');
    const move = agentTools.find((candidate) => candidate.name === 'consultar_horarios_para_reprogramar');

    expect(reserve?.description).toMatch(/hora puntual[^.]*consultar_hora(?![a-z_])/);
    expect(reserve?.description).not.toMatch(/consultar_hora_para_reprogramar[^.]*hora puntual/);
    expect(move?.description).toMatch(/hora puntual[^.]*consultar_hora_para_reprogramar/);
  });

  it('crear_reserva pide el id del horario y, opcional, el nombre', () => {
    const schema = agentSchemaOf('crear_reserva');

    expect(Object.keys(schema.properties)).toEqual(['horario_id', 'nombre']);
    expect(schema.required).toEqual(['horario_id']);
  });

  it('listar_turnos_de_la_clienta no recibe nada: la clienta sale del contexto', () => {
    expect(Object.keys(agentSchemaOf('listar_turnos_de_la_clienta').properties)).toEqual([]);
  });

  it('cancelar_turno pide el turno y si la clienta confirmó; reprogramar_turno solo el id del horario, que ya lleva el turno', () => {
    expect(Object.keys(agentSchemaOf('cancelar_turno').properties)).toEqual(['turno_id', 'confirmada']);
    expect(agentSchemaOf('cancelar_turno').required).toEqual(['turno_id', 'confirmada']);
    expect(Object.keys(agentSchemaOf('reprogramar_turno').properties)).toEqual(['horario_id']);
    expect(agentSchemaOf('reprogramar_turno').required).toEqual(['horario_id']);
  });

  it('reprogramar_turno explica que su horario_id empieza con «reprogramar:» y que no sirve el de reservar', () => {
    const tool = agentTools.find((candidate) => candidate.name === 'reprogramar_turno');

    expect(agentSchemaOf('reprogramar_turno').properties.horario_id?.description).toMatch(/"reprogramar:"/);
    expect(tool?.description).toMatch(/devolvió consultar_horarios_para_reprogramar/);
    expect(tool?.description).toMatch(/No sirve un horario_id de reservar \(empieza con "horario:"\)/);
  });

  it('reprogramar_turno y listar_turnos_de_la_clienta mandan a consultar_horarios_para_reprogramar, no a consultar_disponibilidad (decisión 28)', () => {
    for (const name of ['reprogramar_turno', 'listar_turnos_de_la_clienta']) {
      const tool = agentTools.find((candidate) => candidate.name === name);
      const text = `${tool?.description ?? ''} ${JSON.stringify(z.toJSONSchema(tool?.input ?? z.never(), { io: 'input' }))}`;

      expect(text, name).toContain('consultar_horarios_para_reprogramar');
      expect(text, name).not.toContain('consultar_disponibilidad');
    }
  });

  it('crear_reserva aclara que es para reservar y que un id de reprogramar no sirve', () => {
    const tool = agentTools.find((candidate) => candidate.name === 'crear_reserva');

    expect(tool?.description).toMatch(/reprogramar_turno/);
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
