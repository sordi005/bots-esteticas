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

  it('el botón de una plantilla llega como tipo button y se lee por su dato (8.1, H10)', () => {
    // Ejemplo oficial: developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/button
    const event = onlyMessage('template-button');

    expect(event.type).toBe('button');
    expect(inboundContent(event.message)).toEqual({ text: 'Unsubscribe', replyId: 'Unsubscribe' });
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

/**
 * Ecos de la coexistencia (8.1, H13). Ejemplos oficiales:
 * developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes
 */
describe('parseWebhook: ecos de la coexistencia', () => {
  function onlyEcho(body: unknown) {
    const { events, ignored } = parseWebhook(body);
    expect(ignored).toBe(0);
    expect(events).toHaveLength(1);
    const [event] = events;
    if (event?.kind !== 'echo') throw new Error('No es un eco');
    return event;
  }

  it('un texto que la dueña mandó desde la app trae negocio, clienta, id, fecha y contenido', () => {
    expect(onlyEcho(fixture('echo-text'))).toEqual({
      kind: 'echo',
      phoneNumberId: PHONE_NUMBER_ID,
      to: '16505551234',
      messageId: 'wamid.HBgLMTY0NjcwNDM1OTUVAgARGBIyNDlBOEI5QUQ4NDc0N0FCNjMA',
      timestamp: new Date(1_739_321_024_000),
      type: 'text',
      message: expect.objectContaining({
        text: { body: "Here's the info you requested! https://www.meta.com/quest/quest-3/" },
      }) as unknown,
    });
  });

  it.each([
    ['echo-revoke', 'revoke', 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA='],
    ['echo-edit', 'edit', 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQkJERjg0NDEzNDdFODU3MUMxMAA='],
  ])('%s también es un eco: la dueña borró o editó un mensaje en ese chat', (name, type, messageId) => {
    const event = onlyEcho(fixture(name));

    expect(event).toMatchObject({ to: '16505551234', type, messageId });
  });

  it('un eco sin el teléfono de la clienta (solo nombre de usuario) se ignora sin romper los demás', () => {
    const body = fixture('echo-text') as {
      entry: { changes: { value: { message_echoes: Record<string, unknown>[] } }[] }[];
    };
    const echoes = body.entry[0]?.changes[0]?.value.message_echoes ?? [];
    const [echo] = echoes;
    if (!echo) throw new Error('El ejemplo no trae ecos');
    echoes.push({ ...echo, id: 'wamid.sin-telefono', to: undefined });

    const { events, ignored } = parseWebhook(JSON.parse(JSON.stringify(body)));

    expect(ignored).toBe(1);
    expect(events.map((event) => event.kind === 'echo' && event.messageId)).toEqual([echo.id]);
  });
});

describe('parseWebhook: lo que no se procesa', () => {
  it('ignora cambios de otros campos, como los de la cuenta (H14)', () => {
    const body = fixture('text') as { entry: { changes: { field: string }[] }[] };
    const [entry] = body.entry;
    const [change] = entry?.changes ?? [];
    if (change) change.field = 'account_update';

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
