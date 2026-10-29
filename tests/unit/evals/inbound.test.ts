import { describe, expect, it } from 'vitest';
import { describeInbound } from '../../../src/modules/conversation/agent/message-text.js';
import { inboundContent } from '../../../src/modules/whatsapp/webhook-payload.js';
import type { EvalChoice } from '../../evals/evaluate.js';
import { buildInboundMessage } from '../../evals/inbound.js';

const CANCEL: EvalChoice = { tipo: 'cancelar', turno: 'martes' };
const RESCHEDULE: EvalChoice = { tipo: 'reprogramar', turno: 'martes', inicio: '2026-10-14 15:30' };
const SLOT: EvalChoice = { tipo: 'horario', servicio: 'Esmaltado semipermanente', profesional: 'Mica', inicio: '2026-10-14 15:30' };

/** Un resolvedor de ids de mentira: lo que arma el corredor con la base. */
const resolveId = (choice: EvalChoice) => `id-de-${choice.tipo}`;

describe('buildInboundMessage: texto', () => {
  it('un texto es un mensaje de texto de Meta', () => {
    expect(buildInboundMessage('hola', resolveId)).toEqual({
      type: 'text',
      content: { type: 'text', text: { body: 'hola' } },
    });
  });

  it('el agente lo lee como lo que escribió la clienta', () => {
    const { type, content } = buildInboundMessage('quiero cancelar mi turno', resolveId);

    expect(describeInbound(type, content)).toEqual({ text: 'quiero cancelar mi turno', replyId: null, replyTitle: null });
  });
});

describe('buildInboundMessage: elección', () => {
  it('un botón («Sí, cancelar») es una respuesta interactiva con el id y el título', () => {
    const message = buildInboundMessage({ eleccion: CANCEL, titulo: 'Sí, cancelar' }, resolveId);

    expect(message).toEqual({
      type: 'interactive',
      content: {
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'id-de-cancelar', title: 'Sí, cancelar' } },
      },
    });
    expect(inboundContent(message.content)).toEqual({ text: 'Sí, cancelar', replyId: 'id-de-cancelar' });
  });

  it('un horario es una fila de lista con el id y el título', () => {
    const message = buildInboundMessage({ eleccion: SLOT, titulo: 'mié 14/10 15:30' }, resolveId);

    expect(message.type).toBe('interactive');
    expect(message.content).toEqual({
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'id-de-horario', title: 'mié 14/10 15:30' } },
    });
  });

  it('un horario para reprogramar también es una fila de lista, con el id que arma el corredor', () => {
    const message = buildInboundMessage({ eleccion: RESCHEDULE, titulo: 'mié 14/10 15:30' }, resolveId);

    expect(message.content).toEqual({
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'id-de-reprogramar', title: 'mié 14/10 15:30' } },
    });
    expect(describeInbound(message.type, message.content)).toMatchObject({ replyId: 'id-de-reprogramar' });
  });

  it('el agente lo lee como una elección con su id, no como texto', () => {
    const { type, content } = buildInboundMessage({ eleccion: SLOT, titulo: 'mié 14/10 15:30' }, resolveId);

    expect(describeInbound(type, content)).toMatchObject({ replyId: 'id-de-horario', replyTitle: 'mié 14/10 15:30' });
  });

  it('el resolvedor recibe la elección tal cual', () => {
    const seen: EvalChoice[] = [];
    buildInboundMessage({ eleccion: SLOT, titulo: 'x' }, (choice) => {
      seen.push(choice);
      return 'id';
    });

    expect(seen).toEqual([SLOT]);
  });
});

describe('buildInboundMessage: imagen', () => {
  it('una imagen con texto lleva el texto como caption, con la forma de Meta', () => {
    const message = buildInboundMessage({ imagen: 'quiero este diseño' }, resolveId);

    expect(message.type).toBe('image');
    expect(message.content).toMatchObject({
      type: 'image',
      image: { caption: 'quiero este diseño', mime_type: 'image/jpeg' },
    });
  });

  it('el agente la lee como [Imagen] con lo que escribió', () => {
    const { type, content } = buildInboundMessage({ imagen: 'quiero este diseño' }, resolveId);

    expect(describeInbound(type, content).text).toBe('[Imagen] «quiero este diseño»');
  });

  it('una imagen sin texto no lleva caption', () => {
    const { type, content } = buildInboundMessage({ imagen: null }, resolveId);

    expect(content.image).not.toHaveProperty('caption');
    expect(describeInbound(type, content).text).toBe('[Imagen]');
  });
});

describe('buildInboundMessage: un botón del recordatorio (H10)', () => {
  it('llega como el botón de una plantilla: tipo button, con el id como dato', () => {
    const message = buildInboundMessage(
      { eleccion: { tipo: 'recordatorio', turno: 'martes', accion: 'confirmar' }, titulo: 'Confirmo' },
      () => 'recordatorio:x:confirmar',
    );

    expect(message).toEqual({
      type: 'button',
      content: { type: 'button', button: { payload: 'recordatorio:x:confirmar', text: 'Confirmo' } },
    });
  });

  it('el agente lo lee como una opción tocada, con su id', () => {
    const { type, content } = buildInboundMessage(
      { eleccion: { tipo: 'recordatorio', turno: 'martes', accion: 'cancelar' }, titulo: 'Cancelar' },
      () => 'recordatorio:x:cancelar',
    );

    expect(describeInbound(type, content)).toMatchObject({ replyId: 'recordatorio:x:cancelar', replyTitle: 'Cancelar' });
  });
});
