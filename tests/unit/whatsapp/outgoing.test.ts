import { describe, expect, it } from 'vitest';
import { toGraphPayload, type OutgoingMessage } from '../../../src/modules/whatsapp/outgoing.js';

const TO = '+5492614000001';

const buttons = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `opcion-${String(i)}`, title: `Opción ${String(i)}` }));

const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `fila-${String(i)}`, title: `${String(10 + i)}:00` }));

describe('toGraphPayload: el formato exacto de la API de Meta', () => {
  it('un texto', () => {
    expect(toGraphPayload(TO, { type: 'text', body: 'Hola, soy Luna' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'text',
      text: { body: 'Hola, soy Luna', preview_url: false },
    });
  });

  it('botones de respuesta, con pie opcional', () => {
    const message: OutgoingMessage = {
      type: 'buttons',
      body: '¿Confirmás tu turno de mañana a las 15:30?',
      footer: 'Estética Ejemplo',
      buttons: [
        { id: 'confirm', title: 'Confirmo' },
        { id: 'reschedule', title: 'Reprogramar' },
        { id: 'cancel', title: 'Cancelar' },
      ],
    };

    expect(toGraphPayload(TO, message)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '¿Confirmás tu turno de mañana a las 15:30?' },
        footer: { text: 'Estética Ejemplo' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'confirm', title: 'Confirmo' } },
            { type: 'reply', reply: { id: 'reschedule', title: 'Reprogramar' } },
            { type: 'reply', reply: { id: 'cancel', title: 'Cancelar' } },
          ],
        },
      },
    });
  });

  it('una lista con secciones', () => {
    const message: OutgoingMessage = {
      type: 'list',
      body: 'Para el viernes tengo estos horarios:',
      buttonLabel: 'Ver horarios',
      sections: [
        { title: 'Mañana', rows: [{ id: 'slot-1', title: '10:00', description: 'Con Mica' }] },
        { title: 'Tarde', rows: [{ id: 'slot-2', title: '15:30' }] },
      ],
    };

    expect(toGraphPayload(TO, message)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'Para el viernes tengo estos horarios:' },
        action: {
          button: 'Ver horarios',
          sections: [
            { title: 'Mañana', rows: [{ id: 'slot-1', title: '10:00', description: 'Con Mica' }] },
            { title: 'Tarde', rows: [{ id: 'slot-2', title: '15:30' }] },
          ],
        },
      },
    });
  });
});

describe('toGraphPayload: los límites de Meta se validan antes de enviar', () => {
  it.each<[string, OutgoingMessage]>([
    ['un texto vacío', { type: 'text', body: '' }],
    ['un texto de más de 4096 caracteres', { type: 'text', body: 'a'.repeat(4097) }],
    ['más de 3 botones', { type: 'buttons', body: 'Elegí', buttons: buttons(4) }],
    ['ningún botón', { type: 'buttons', body: 'Elegí', buttons: [] }],
    ['un botón de más de 20 caracteres', { type: 'buttons', body: 'Elegí', buttons: [{ id: 'x', title: 'a'.repeat(21) }] }],
    ['dos botones con el mismo id', { type: 'buttons', body: 'Elegí', buttons: [{ id: 'x', title: 'Uno' }, { id: 'x', title: 'Dos' }] }],
    ['más de 10 filas en total', { type: 'list', body: 'Elegí', buttonLabel: 'Ver', sections: [{ title: 'A', rows: rows(6) }, { title: 'B', rows: rows(5) }] }],
    ['una fila de más de 24 caracteres', { type: 'list', body: 'Elegí', buttonLabel: 'Ver', sections: [{ rows: [{ id: 'x', title: 'a'.repeat(25) }] }] }],
    ['varias secciones sin título', { type: 'list', body: 'Elegí', buttonLabel: 'Ver', sections: [{ rows: rows(1) }, { rows: rows(1) }] }],
  ])('rechaza %s', (_case, message) => {
    expect(() => toGraphPayload(TO, message)).toThrow();
  });

  it('acepta justo el máximo: 3 botones de 20 caracteres', () => {
    const message: OutgoingMessage = {
      type: 'buttons',
      body: 'Elegí',
      buttons: buttons(3).map((button, i) => ({ ...button, title: `${String(i)}${'a'.repeat(19)}` })),
    };

    expect(() => toGraphPayload(TO, message)).not.toThrow();
  });
});
