import { describe, expect, it } from 'vitest';
import { echoReply } from '../../../src/cli/echo-reply.js';

describe('echoReply: la herramienta de prueba de H5 contesta lo que recibe', () => {
  it('repite un texto', () => {
    expect(echoReply({ type: 'text', text: { body: 'hola' } })).toEqual({ type: 'text', body: 'Eco: hola' });
  });

  it('con "botones" manda botones de respuesta, para probar mensajes interactivos', () => {
    expect(echoReply({ type: 'text', text: { body: '  Botones ' } })).toMatchObject({
      type: 'buttons',
      buttons: [
        { id: 'confirm', title: 'Confirmo' },
        { id: 'reschedule', title: 'Reprogramar' },
        { id: 'cancel', title: 'Cancelar' },
      ],
    });
  });

  it('con "lista" manda una lista de horarios', () => {
    expect(echoReply({ type: 'text', text: { body: 'lista' } })).toMatchObject({
      type: 'list',
      buttonLabel: 'Ver horarios',
    });
  });

  it('confirma qué opción eligió la clienta, con su id', () => {
    expect(
      echoReply({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'confirm', title: 'Confirmo' } } }),
    ).toEqual({ type: 'text', body: 'Elegiste: Confirmo (confirm)' });
  });

  it('avisa el tipo de un mensaje que no es texto', () => {
    expect(echoReply({ type: 'audio', audio: { id: '1', voice: true } })).toEqual({
      type: 'text',
      body: 'Recibí un mensaje de tipo audio',
    });
  });
});
