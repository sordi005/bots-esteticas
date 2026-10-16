import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inboundImageId, parseWebhook } from '../../../src/modules/whatsapp/webhook-payload.js';

/** El id de la imagen de un mensaje: es lo que se guarda como comprobante (4.5). */
describe('inboundImageId', () => {
  it('lee el id de la imagen del ejemplo oficial de Meta', () => {
    const body: unknown = JSON.parse(readFileSync('tests/contracts/whatsapp/image.json', 'utf8'));
    const [event] = parseWebhook(body).events;

    expect(event?.kind === 'message' ? inboundImageId(event.message) : 'no es un mensaje').toBe('1003383421387256');
  });

  it.each([
    ['un texto', { type: 'text', text: { body: 'hola' } }],
    ['una imagen sin id', { type: 'image', image: { mime_type: 'image/jpeg' } }],
    ['un audio', { type: 'audio', audio: { id: '1' } }],
  ])('%s no tiene imagen', (_case, message) => {
    expect(inboundImageId(message)).toBeNull();
  });
});
