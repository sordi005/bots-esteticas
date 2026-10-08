import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, type PromptTenant } from '../../../../src/modules/conversation/agent/system-prompt.js';
import { consultationTools } from '../../../../src/modules/conversation/tools/index.js';

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

    for (const tool of consultationTools) expect(prompt).toContain(tool.name);
    // En H7 no existen crear_reserva ni derivar_a_persona: el prompt no puede prometerlas.
    expect(mentioned).not.toContain('crear_reserva');
    expect(mentioned).not.toContain('derivar_a_persona');
  });

  it('no permite reservar ni derivar todavía: manda a la clienta con una persona del equipo por el mismo chat', () => {
    const prompt = buildSystemPrompt(example);

    expect(prompt).toMatch(/una persona del equipo/);
    expect(prompt).toMatch(/por este mismo chat/);
  });

  it('prohíbe pedir o repetir detalles de salud (regla 9)', () => {
    expect(buildSystemPrompt(example)).toMatch(/salud/i);
    expect(buildSystemPrompt(example)).toMatch(/no le pidas ni le repitas detalles/i);
  });
});
