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
