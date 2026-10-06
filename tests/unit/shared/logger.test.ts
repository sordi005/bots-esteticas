import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../../../src/server.js';
import { createLogger } from '../../../src/shared/logger.js';

const VERIFY_TOKEN = 'token-de-verificacion-que-no-se-loguea';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('no guarda el query string de las URLs: la verificación de Meta trae el token ahí', async () => {
    const { lines, stream } = capture();
    const server = buildServer({
      healthChecks: {},
      logger: createLogger({ logLevel: 'info' }, stream),
      whatsappWebhook: { appSecret: 'secreto', verifyToken: VERIFY_TOKEN, onEvents: () => Promise.resolve() },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`,
    });
    await server.close();

    expect(response.body).toBe('42');
    const log = lines.join('');
    expect(log).toContain('"url":"/webhooks/whatsapp"');
    expect(log).not.toContain(VERIFY_TOKEN);
  });

  it('tampoco guarda el header de autorización', async () => {
    const { lines, stream } = capture();
    const server = buildServer({ healthChecks: {}, logger: createLogger({ logLevel: 'info' }, stream) });

    await server.inject({ method: 'GET', url: '/no-existe', headers: { authorization: 'Bearer EAAG-secreto' } });
    await server.close();

    expect(lines.join('')).not.toContain('EAAG-secreto');
  });
});
