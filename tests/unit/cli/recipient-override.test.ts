import { describe, expect, it } from 'vitest';
import { withRecipientOverride } from '../../../src/cli/recipient-override.js';
import type { SendMessageInput, WhatsAppClient } from '../../../src/modules/whatsapp/client.js';

function recordingClient() {
  const sent: SendMessageInput[] = [];
  const client: WhatsAppClient = {
    sendMessage: (input) => {
      sent.push(input);
      return Promise.resolve({ messageId: 'wamid.1' });
    },
  };
  return { client, sent };
}

const INPUT: SendMessageInput = {
  phoneNumberId: '1004988256039822',
  accessToken: 'token',
  to: '+5492615362239',
  message: { type: 'text', body: 'Eco: hola' },
};

describe('withRecipientOverride', () => {
  it('manda todo al número indicado y deja el resto del envío igual', async () => {
    const { client, sent } = recordingClient();

    const result = await withRecipientOverride(client, '54261155362239').sendMessage(INPUT);

    expect(result).toEqual({ messageId: 'wamid.1' });
    expect(sent).toEqual([{ ...INPUT, to: '54261155362239' }]);
  });

  it('sin número, devuelve el mismo cliente', async () => {
    const { client, sent } = recordingClient();

    const same = withRecipientOverride(client, undefined);
    await same.sendMessage(INPUT);

    expect(same).toBe(client);
    expect(sent).toEqual([INPUT]);
  });
});
