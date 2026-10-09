import { describe, expect, it } from 'vitest';
import {
  CHOICE_MARKER,
  describeInbound,
  outgoingToText,
} from '../../../../src/modules/conversation/agent/message-text.js';

describe('describeInbound: lo que dijo la clienta, como texto para el modelo', () => {
  it('un texto pasa tal cual', () => {
    expect(describeInbound('text', { type: 'text', text: { body: '¿Tenés turno mañana?' } })).toEqual({
      text: '¿Tenés turno mañana?',
      replyId: null,
      replyTitle: null,
    });
  });

  it('un botón o una fila de lista devuelven el id para resolverlo y un marcador: el título no se le muestra como pedido', () => {
    const button = describeInbound('interactive', {
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'servicio:abc', title: 'Semipermanente' } },
    });
    const row = describeInbound('interactive', {
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'horario:x', title: 'lun 5/10 9:00', description: 'Mica' } },
    });

    expect(button).toEqual({ text: CHOICE_MARKER, replyId: 'servicio:abc', replyTitle: 'Semipermanente' });
    expect(row).toEqual({ text: CHOICE_MARKER, replyId: 'horario:x', replyTitle: 'lun 5/10 9:00' });
  });

  it.each([
    ['audio', '[Audio]'],
    ['sticker', '[Sticker]'],
    ['location', '[Ubicación]'],
    ['contacts', '[Contacto]'],
    ['video', '[Video]'],
    ['document', '[Documento]'],
    ['unsupported', '[Mensaje que no se puede leer]'],
    ['reaction', '[Mensaje que no se puede leer]'],
  ])('un mensaje de tipo %s llega como el marcador %s', (type, marker) => {
    expect(describeInbound(type, { type })).toEqual({ text: marker, replyId: null, replyTitle: null });
  });

  it('una imagen llega como marcador, con su texto si lo trae', () => {
    expect(describeInbound('image', { type: 'image', image: { id: '1', mime_type: 'image/jpeg' } }).text).toBe(
      '[Imagen]',
    );
    expect(
      describeInbound('image', { type: 'image', image: { id: '1', mime_type: 'image/jpeg', caption: 'Quiero este diseño' } })
        .text,
    ).toBe('[Imagen] «Quiero este diseño»');
  });

  it('un texto con la forma rota no rompe: llega como mensaje que no se puede leer', () => {
    expect(describeInbound('text', { type: 'text' }).text).toBe('[Mensaje que no se puede leer]');
  });
});

describe('outgoingToText: lo que dijo el asistente antes, como texto para el modelo', () => {
  it('un texto pasa tal cual', () => {
    expect(outgoingToText({ type: 'text', body: 'Hola, soy Luna.' })).toBe('Hola, soy Luna.');
  });

  it('los botones agregan los títulos de las opciones', () => {
    expect(
      outgoingToText({
        type: 'buttons',
        body: '¿Cuál te interesa?',
        buttons: [
          { id: 'a', title: 'Semipermanente' },
          { id: 'b', title: 'Uñas esculpidas' },
        ],
      }),
    ).toBe('¿Cuál te interesa?\n[Botones: Semipermanente | Uñas esculpidas]');
  });

  it('una lista agrega los títulos de todas sus filas', () => {
    expect(
      outgoingToText({
        type: 'list',
        body: 'Tengo estos horarios:',
        buttonLabel: 'Ver opciones',
        sections: [
          { title: 'Lunes', rows: [{ id: '1', title: 'lun 5/10 9:00' }] },
          { title: 'Martes', rows: [{ id: '2', title: 'mar 6/10 10:00', description: 'Con Sofi' }] },
        ],
      }),
    ).toBe('Tengo estos horarios:\n[Opciones: lun 5/10 9:00 | mar 6/10 10:00]');
  });

  it('un contenido guardado que no es un mensaje válido se ignora (null)', () => {
    expect(outgoingToText({ type: 'plantilla' })).toBeNull();
    expect(outgoingToText({})).toBeNull();
  });
});
