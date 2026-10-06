import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inboundContent, parseWebhook } from '../../src/modules/whatsapp/webhook-payload.js';

/**
 * Contratos con Meta (sección 11.3): los archivos de `whatsapp/` son los ejemplos oficiales
 * de developers.facebook.com/docs/whatsapp/cloud-api/webhooks, copiados tal cual.
 * Si Meta cambia el formato, se agrega el ejemplo nuevo y el parser se adapta.
 */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`whatsapp/${name}.json`, import.meta.url), 'utf8'));
}

const PHONE_NUMBER_ID = '106540352242922';

function onlyMessage(name: string) {
  const { events, ignored } = parseWebhook(fixture(name));
  expect(ignored).toBe(0);
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event?.kind !== 'message') throw new Error(`${name} no es un mensaje`);
  return event;
}

describe('parseWebhook: mensajes recibidos', () => {
  it('un texto trae negocio, clienta, id, fecha y contenido', () => {
    const event = onlyMessage('text');

    expect(event).toEqual({
      kind: 'message',
      phoneNumberId: PHONE_NUMBER_ID,
      from: '16505551234',
      profileName: 'Sheena Nelson',
      messageId: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
      timestamp: new Date(1_749_416_383_000),
      type: 'text',
      message: expect.objectContaining({ text: { body: 'Does it come in another color?' } }) as unknown,
    });
    expect(inboundContent(event.message)).toEqual({ text: 'Does it come in another color?', replyId: null });
  });

  it.each([
    ['button-reply', { text: 'Cancel', replyId: 'cancel-button' }],
    ['list-reply', { text: 'Priority Mail Express', replyId: 'priority_express' }],
  ])('una respuesta a %s se lee como elección estructurada (sección 5.3)', (name, content) => {
    const event = onlyMessage(name);

    expect(event.type).toBe('interactive');
    expect(inboundContent(event.message)).toEqual(content);
  });

  it.each([
    ['image', 'image', 'Taj Mahal'],
    ['audio', 'audio', null],
    ['location', 'location', null],
    ['sticker', 'sticker', null],
    ['unsupported', 'unsupported', null],
  ])('un mensaje de tipo %s se guarda con su tipo y su contenido completo', (name, type, text) => {
    const event = onlyMessage(name);

    expect(event.type).toBe(type);
    expect(event.message).toHaveProperty(type);
    expect(inboundContent(event.message)).toEqual({ text, replyId: null });
  });
});

describe('parseWebhook: estados de los mensajes enviados', () => {
  it.each([
    ['status-delivered', 'delivered', 'service'],
    ['status-sent', 'sent', 'marketing'],
    ['status-without-pricing', 'sent', null],
  ])('%s trae el estado y la categoría de precio de Meta', (name, status, pricingCategory) => {
    const { events } = parseWebhook(fixture(name));

    expect(events).toEqual([
      expect.objectContaining({ kind: 'status', phoneNumberId: PHONE_NUMBER_ID, status, pricingCategory, errors: [] }),
    ]);
  });

  it('un envío fallido trae el código y el título del error', () => {
    const { events } = parseWebhook(fixture('status-failed'));

    expect(events).toEqual([
      {
        kind: 'status',
        phoneNumberId: PHONE_NUMBER_ID,
        messageId: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI0QUQ2MjA4NEYyRkExNjMyREUA',
        recipientId: '16505551234',
        status: 'failed',
        timestamp: new Date(1_751_142_888_000),
        pricingCategory: null,
        errors: [
          {
            code: 131049,
            title: 'This message was not delivered to maintain healthy ecosystem engagement.',
          },
        ],
      },
    ]);
  });
});

describe('parseWebhook: lo que no se procesa', () => {
  it('ignora cambios de otros campos, como los ecos de la coexistencia (H13)', () => {
    const body = fixture('text') as { entry: { changes: { field: string }[] }[] };
    const [entry] = body.entry;
    const [change] = entry?.changes ?? [];
    if (change) change.field = 'smb_message_echoes';

    expect(parseWebhook(body)).toEqual({ events: [], ignored: 1 });
  });

  it('cuenta como ignorado un cambio con un formato inesperado, sin romper el resto', () => {
    expect(
      parseWebhook({
        object: 'whatsapp_business_account',
        entry: [{ id: '1', changes: [{ field: 'messages', value: { algo: 'distinto' } }] }],
      }),
    ).toEqual({ events: [], ignored: 1 });
  });

  it('no acepta algo que no es un webhook de WhatsApp', () => {
    expect(parseWebhook({ object: 'page', entry: [] })).toEqual({ events: [], ignored: 1 });
    expect(parseWebhook('texto')).toEqual({ events: [], ignored: 1 });
  });
});
