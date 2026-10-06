import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { echoReply } from '../../../src/modules/conversation/echo-responder.js';
import type { ReceivedMessage } from '../../../src/modules/conversation/processing.js';

const OCCURRED_AT = new Date('2026-10-06T15:00:00.000Z');

function received(content: Record<string, unknown>): ReceivedMessage {
  return {
    id: randomUUID(),
    type: typeof content.type === 'string' ? content.type : 'text',
    content,
    occurredAt: OCCURRED_AT,
  };
}

const text = (body: string) => received({ type: 'text', text: { body } });

describe('echoReply: la respuesta de desarrollo del worker hasta H7', () => {
  it('repite un texto', () => {
    expect(echoReply([text('hola')])).toEqual({ type: 'text', body: 'Eco: hola' });
  });

  it('junta en una sola respuesta los mensajes que llegaron seguidos (5.2)', () => {
    expect(echoReply([text('hola'), text('quería saber'), text('si tenés turno mañana')])).toEqual({
      type: 'text',
      body: 'Eco de 3 mensajes: hola / quería saber / si tenés turno mañana',
    });
  });

  it('con "botones" como último mensaje manda botones de respuesta', () => {
    expect(echoReply([text('hola'), text('  Botones ')])).toMatchObject({
      type: 'buttons',
      buttons: [
        { id: 'confirm', title: 'Confirmo' },
        { id: 'reschedule', title: 'Reprogramar' },
        { id: 'cancel', title: 'Cancelar' },
      ],
    });
  });

  it('con "lista" manda una lista de horarios', () => {
    expect(echoReply([text('lista')])).toMatchObject({ type: 'list', buttonLabel: 'Ver horarios' });
  });

  it('confirma qué opción eligió la clienta, con su id', () => {
    const choice = received({
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'confirm', title: 'Confirmo' } },
    });

    expect(echoReply([choice])).toEqual({ type: 'text', body: 'Elegiste: Confirmo (confirm)' });
  });

  it('avisa el tipo de un mensaje que no es texto', () => {
    expect(echoReply([received({ type: 'audio', audio: { id: '1', voice: true } })])).toEqual({
      type: 'text',
      body: 'Recibí un mensaje de tipo audio',
    });
  });

  it('entre varios mensajes, marca con su tipo los que no son texto', () => {
    expect(echoReply([text('hola'), received({ type: 'sticker', sticker: { id: '1' } })])).toEqual({
      type: 'text',
      body: 'Eco de 2 mensajes: hola / [sticker]',
    });
  });

  it('no se pasa del largo máximo de un texto de WhatsApp', () => {
    const reply = echoReply(Array.from({ length: 10 }, () => text('x'.repeat(1_000))));

    expect(reply.type === 'text' ? reply.body.length : 0).toBe(4_096);
  });
});
