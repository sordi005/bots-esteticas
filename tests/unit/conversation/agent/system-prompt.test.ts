import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSystemPrompt, type PromptTenant } from '../../../../src/modules/conversation/agent/system-prompt.js';
import { agentTools } from '../../../../src/modules/conversation/tools/index.js';

const example: PromptTenant = { name: 'Estética Ejemplo', assistantName: 'Luna', emojiUsage: 'low', usesVoseo: true };

describe('buildSystemPrompt: se arma por negocio desde la configuración (8.5)', () => {
  it('nombra al negocio y al asistente', () => {
    const prompt = buildSystemPrompt(example);

    expect(prompt).toContain('Luna');
    expect(prompt).toContain('Estética Ejemplo');
    expect(buildSystemPrompt({ ...example, name: 'Centro Aura', assistantName: 'Sol' })).toMatch(/Sol.*Centro Aura/s);
  });

  it('es idéntico entre llamadas del mismo negocio, para que el proveedor reutilice la caché', () => {
    expect(buildSystemPrompt(example)).toBe(buildSystemPrompt({ ...example }));
  });

  it('no lleva fechas, horas ni datos de la clienta: eso va en el contexto de la vuelta', () => {
    const prompt = buildSystemPrompt(example);

    expect(prompt).not.toMatch(/\d{1,2}\/\d{1,2}\/?\d{0,4}/);
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(prompt).not.toMatch(/\d{1,2}:\d{2}/);
    expect(prompt).not.toMatch(/20\d{2}/);
  });

  it('cambia con el uso de emojis', () => {
    const none = buildSystemPrompt({ ...example, emojiUsage: 'none' });
    const low = buildSystemPrompt({ ...example, emojiUsage: 'low' });
    const medium = buildSystemPrompt({ ...example, emojiUsage: 'medium' });

    expect(new Set([none, low, medium]).size).toBe(3);
    expect(none).toMatch(/no uses emojis/i);
  });

  it('cambia con el voseo', () => {
    const voseo = buildSystemPrompt({ ...example, usesVoseo: true });
    const tuteo = buildSystemPrompt({ ...example, usesVoseo: false });

    expect(voseo).not.toBe(tuteo);
    expect(voseo).toMatch(/tenés/);
    expect(tuteo).toMatch(/tienes/);
  });

  it('le pide presentarse como asistente virtual y no fingir ser una persona (5.1)', () => {
    expect(buildSystemPrompt(example)).toMatch(/asistente virtual/i);
    expect(buildSystemPrompt(example)).toMatch(/nunca fingís ser una persona/i);
  });

  it('nombra las herramientas que existen, y solo esas', () => {
    const prompt = buildSystemPrompt(example);
    const mentioned = [...prompt.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((match) => match[1]);

    for (const tool of agentTools) expect(prompt).toContain(tool.name);
    // Las herramientas de turnos llegan en la etapa B de H8: hasta entonces el prompt no puede prometerlas.
    expect(mentioned).not.toContain('crear_reserva');
    expect(mentioned).not.toContain('cancelar_turno');
  });

  it('todavía no puede reservar: manda a la clienta con una persona del equipo por el mismo chat', () => {
    const prompt = buildSystemPrompt(example);

    expect(prompt).toMatch(/una persona del equipo/);
    expect(prompt).toMatch(/por este mismo chat/);
    expect(prompt).toMatch(/Todavía no podés reservar/);
  });

  it('ante un precio inventado por la clienta, pide decir el precio real buscándolo con la herramienta', () => {
    // Lo encontró la evaluación inyeccion_precio: el modelo no aceptaba el precio, pero tampoco
    // decía el verdadero, y la clienta tenía que volver a preguntar.
    expect(buildSystemPrompt(example)).toMatch(/precio real.*buscar_servicios/s);
  });

  it('no nombra servicios de memoria, ni como ejemplo: los busca en el catálogo', () => {
    // Lo encontró la prueba manual: a "hola" contestó "por ejemplo, manicura, depilación o
    // masajes" sin llamar a ninguna herramienta, y masajes no está en el catálogo.
    expect(buildSystemPrompt(example)).toMatch(/nunca nombres servicios de memoria/i);
  });

  it('cuando la clienta elige un horario, no le dice que quedó anotado', () => {
    // Lo encontró la prueba manual: "Perfecto, anotado" suena a turno reservado y en H7 no lo está.
    expect(buildSystemPrompt(example)).toMatch(/«anotado»/);
    expect(buildSystemPrompt(example)).toMatch(/todavía no está reservado/);
  });

  it('no ofrece reservar: en H7 no puede', () => {
    expect(buildSystemPrompt(example)).not.toMatch(/te ayudo con la reserva/i);
    expect(buildSystemPrompt(example)).toMatch(/no ofrezcas reservar/i);
  });

  it('prohíbe pedir o repetir detalles de salud (regla 9)', () => {
    expect(buildSystemPrompt(example)).toMatch(/salud/i);
    expect(buildSystemPrompt(example)).toMatch(/no le pidas ni le repitas detalles/i);
  });
});

describe('buildSystemPrompt: derivar a una persona (4.8)', () => {
  const prompt = buildSystemPrompt(example);

  it('ya no dice que no puede derivar, y la derivación tiene su propia sección', () => {
    expect(prompt).not.toMatch(/todavía no podés derivar/i);
    expect(prompt).toMatch(/## Derivar a una persona/);
    // La sección de «lo que todavía no podés hacer» queda solo para las reservas.
    const notYet = prompt.slice(prompt.indexOf('## Lo que todavía no podés hacer'), prompt.indexOf('## Mensajes que no son texto'));
    expect(notYet).not.toContain('derivar_a_persona');
  });

  it('nombra todos los motivos de la herramienta, con los mismos nombres que ve el modelo', () => {
    const tool = agentTools.find((candidate) => candidate.name === 'derivar_a_persona');
    if (!tool) throw new Error('No está derivar_a_persona');
    const motivos = (z.toJSONSchema(tool.input, { io: 'input' }) as unknown as {
      properties: { motivo: { enum: string[] } };
    }).properties.motivo.enum;

    expect(motivos).toHaveLength(8);
    for (const motivo of motivos) expect(prompt, motivo).toContain(motivo);
  });

  it('pide derivar cuando la clienta pide una persona, se queja, manda una imagen, quiere un servicio con consulta previa o pide una excepción', () => {
    expect(prompt).toMatch(/pide hablar con una persona/i);
    expect(prompt).toMatch(/queja|enojo/i);
    expect(prompt).toMatch(/\[Imagen\]/);
    expect(prompt).toMatch(/consulta previa/i);
    expect(prompt).toMatch(/devolución|excepción/i);
    expect(prompt).toMatch(/dos intentos/i);
  });

  it('con temas de salud: no pide ni repite detalles, deriva como tema sensible y el resumen no lleva datos de salud (regla 9)', () => {
    expect(prompt).toMatch(/no le pidas ni le repitas detalles/i);
    expect(prompt).toMatch(/tema_sensible/);
    expect(prompt).toMatch(/resumen[^.]*sin ningún dato de salud/i);
  });

  it('ante un servicio que no está en el catálogo o un dato no cargado, ofrece una persona y deriva solo si acepta o insiste', () => {
    expect(prompt).toMatch(/no está en el catálogo[^.]*ofrecele que la ayude una persona/i);
    expect(prompt).toMatch(/solo si (ella )?acepta o insiste/i);
  });

  it('después de derivar usa el texto de cuándo que devuelve la herramienta y no promete nada más', () => {
    expect(prompt).toMatch(/«cuando»/);
    expect(prompt).toMatch(/no le prometas nada más/i);
    expect(prompt).toMatch(/«opciones» va vacía/);
  });

  it('no deriva de entrada ante un audio: pide que lo escriba y ofrece una persona', () => {
    const audio = prompt.slice(prompt.indexOf('- [Audio]'), prompt.indexOf('- [Sticker]'));

    expect(audio).toMatch(/escriba/);
    expect(audio).toMatch(/ofrecele que una persona/);
    expect(audio).toMatch(/solo si acepta o insiste/);
  });

  it('ante una imagen deriva con el motivo imagen', () => {
    const image = prompt.slice(prompt.indexOf('- [Imagen]'), prompt.indexOf('- [Audio]'));

    expect(image).toMatch(/derivá con el motivo imagen/);
  });

  it('sigue siendo idéntico entre llamadas del mismo negocio, para la caché del proveedor', () => {
    expect(buildSystemPrompt({ ...example })).toBe(prompt);
  });
});
