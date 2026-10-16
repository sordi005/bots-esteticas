import { describe, expect, it } from 'vitest';
import { createWhatsAppClient, WhatsAppApiError } from '../../../src/modules/whatsapp/client.js';

const TOKEN = 'EAAG-token-secreto';

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown, captured: Captured[] = []): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
  };
}

const OK_RESPONSE = {
  messaging_product: 'whatsapp',
  contacts: [{ input: '+5492614000001', wa_id: '5492614000001' }],
  messages: [{ id: 'wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA' }],
};

/** Responde cada pedido con la respuesta que le toca, en orden, y los registra. */
function scriptedFetch(responses: Response[], captured: Captured[] = []): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('Pedido de más');
    return Promise.resolve(next);
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const send = (client: ReturnType<typeof createWhatsAppClient>) =>
  client.sendMessage({
    phoneNumberId: '106540352242922',
    accessToken: TOKEN,
    to: '+5492614000001',
    message: { type: 'text', body: 'Hola' },
  });

describe('createWhatsAppClient().sendMessage', () => {
  it('hace POST a la API de Meta con el token y devuelve el id del mensaje', async () => {
    const captured: Captured[] = [];
    const client = createWhatsAppClient({ graphApiVersion: 'v26.0', fetch: fakeFetch(200, OK_RESPONSE, captured) });

    const result = await send(client);

    expect(result).toEqual({ messageId: 'wamid.HBgLMTY0NjcwNDM1OTUVAgARGBI1RjQyNUE3NEYxMzAzMzQ5MkEA' });
    const [request] = captured;
    expect(request?.url).toBe('https://graph.facebook.com/v26.0/106540352242922/messages');
    expect(request?.init.method).toBe('POST');
    expect(new Headers(request?.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const body = request?.init.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(typeof body === 'string' ? body : '{}')).toMatchObject({ to: '+5492614000001', type: 'text' });
  });

  it('un error de Meta se convierte en un error con su código, sin el token', async () => {
    const client = createWhatsAppClient({
      graphApiVersion: 'v26.0',
      fetch: fakeFetch(400, {
        error: { message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', code: 131030 },
      }),
    });

    const error = await send(client).catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(WhatsAppApiError);
    expect(error).toMatchObject({ status: 400, code: 131030 });
    expect(String(error)).toContain('Recipient phone number not in allowed list');
    expect(String(error)).not.toContain(TOKEN);
  });

  it('una respuesta exitosa sin id de mensaje es un error, no un éxito silencioso', async () => {
    const client = createWhatsAppClient({ graphApiVersion: 'v26.0', fetch: fakeFetch(200, { messages: [] }) });

    await expect(send(client)).rejects.toThrow(WhatsAppApiError);
  });

  it('no llama a Meta si el mensaje no cumple los límites', async () => {
    const captured: Captured[] = [];
    const client = createWhatsAppClient({ graphApiVersion: 'v26.0', fetch: fakeFetch(200, OK_RESPONSE, captured) });

    await expect(
      client.sendMessage({
        phoneNumberId: '1',
        accessToken: TOKEN,
        to: '+5492614000001',
        message: { type: 'buttons', body: 'Elegí', buttons: [] },
      }),
    ).rejects.toThrow();
    expect(captured).toEqual([]);
  });
});

// Formatos de https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
describe('createWhatsAppClient().downloadMedia: bajar una imagen recibida (8.2)', () => {
  const MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1003383421387256';
  const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  it('pide la URL de la imagen y la descarga con el token, devolviendo los bytes y el tipo', async () => {
    const captured: Captured[] = [];
    const client = createWhatsAppClient({
      graphApiVersion: 'v26.0',
      fetch: scriptedFetch(
        [
          json(200, {
            messaging_product: 'whatsapp',
            url: MEDIA_URL,
            mime_type: 'image/jpeg',
            sha256: 'SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=',
            file_size: '7',
            id: '1003383421387256',
          }),
          new Response(IMAGE, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
        ],
        captured,
      ),
    });

    const media = await client.downloadMedia({ mediaId: '1003383421387256', accessToken: TOKEN });

    expect(media.mimeType).toBe('image/jpeg');
    expect([...media.data]).toEqual([...IMAGE]);
    expect(captured.map((request) => request.url)).toEqual([
      'https://graph.facebook.com/v26.0/1003383421387256',
      MEDIA_URL,
    ]);
    for (const request of captured) {
      expect(new Headers(request.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('si Meta no encuentra la imagen (venció a los 7 días), es un error con su código y sin el token', async () => {
    const client = createWhatsAppClient({
      graphApiVersion: 'v26.0',
      fetch: scriptedFetch([json(400, { error: { message: 'Unsupported get request', code: 100 } })]),
    });

    const error = await client
      .downloadMedia({ mediaId: '1', accessToken: TOKEN })
      .catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(WhatsAppApiError);
    expect(error).toMatchObject({ status: 400, code: 100 });
    expect(String(error)).not.toContain(TOKEN);
  });

  it('si falla la descarga del archivo, es un error', async () => {
    const client = createWhatsAppClient({
      graphApiVersion: 'v26.0',
      fetch: scriptedFetch([
        json(200, { messaging_product: 'whatsapp', url: MEDIA_URL, mime_type: 'image/jpeg', id: '1' }),
        new Response('', { status: 404 }),
      ]),
    });

    await expect(client.downloadMedia({ mediaId: '1', accessToken: TOKEN })).rejects.toThrow(WhatsAppApiError);
  });
});

describe('createWhatsAppClient().uploadMedia: subir una imagen al número que envía (8.2)', () => {
  it('hace POST multipart a /{phone_number_id}/media y devuelve el id nuevo', async () => {
    const captured: Captured[] = [];
    const client = createWhatsAppClient({
      graphApiVersion: 'v26.0',
      fetch: scriptedFetch([json(200, { id: '1037543291543636' })], captured),
    });

    const result = await client.uploadMedia({
      phoneNumberId: '106540352242922',
      accessToken: TOKEN,
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'image/jpeg',
    });

    expect(result).toEqual({ mediaId: '1037543291543636' });
    const [request] = captured;
    expect(request?.url).toBe('https://graph.facebook.com/v26.0/106540352242922/media');
    expect(request?.init.method).toBe('POST');
    expect(new Headers(request?.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const form = request?.init.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) return;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('image/jpeg');
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    if (file instanceof Blob) expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('un error de Meta al subir se convierte en un error con su código', async () => {
    const client = createWhatsAppClient({
      graphApiVersion: 'v26.0',
      fetch: scriptedFetch([json(400, { error: { message: 'Param file must be a file', code: 100 } })]),
    });

    await expect(
      client.uploadMedia({ phoneNumberId: '1', accessToken: TOKEN, data: new Uint8Array([1]), mimeType: 'image/jpeg' }),
    ).rejects.toMatchObject({ status: 400, code: 100 });
  });
});
