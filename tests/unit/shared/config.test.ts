import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/shared/config.js';

const databaseUrl = 'postgres://postgres:secreta@localhost:5434/bots_esteticas';
const KEY = Buffer.alloc(32, 7).toString('base64');

/** Todo lo que producción exige. */
const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: databaseUrl,
  CREDENTIALS_ENCRYPTION_KEY: KEY,
  WHATSAPP_APP_SECRET: 'secreto-de-la-app',
  WHATSAPP_VERIFY_TOKEN: 'token-de-verificacion',
};

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('Se lanzó algo que no es un Error', { cause: error });
  }
  throw new Error('Se esperaba un error y no se lanzó ninguno');
}

describe('loadConfig', () => {
  it('aplica los valores por defecto cuando solo está DATABASE_URL', () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl })).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      databaseUrl,
      credentialsKey: null,
      whatsapp: null,
    });
  });

  it('lee los valores del entorno y convierte PORT a número', () => {
    const config = loadConfig({ ...PRODUCTION, HOST: '127.0.0.1', PORT: '8080', LOG_LEVEL: 'warn' });

    expect(config).toEqual({
      nodeEnv: 'production',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'warn',
      databaseUrl,
      credentialsKey: Buffer.from(KEY, 'base64'),
      whatsapp: { appSecret: 'secreto-de-la-app', verifyToken: 'token-de-verificacion', graphApiVersion: 'v25.0' },
    });
  });

  it.each(['WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'CREDENTIALS_ENCRYPTION_KEY'])(
    'en producción %s es obligatoria',
    (name) => {
      const error = captureError(() => loadConfig({ ...PRODUCTION, [name]: undefined }));

      expect(error.message).toContain(name);
    },
  );

  it('en producción rechaza la clave de ejemplo de .env.example (todos ceros)', () => {
    const error = captureError(() =>
      loadConfig({ ...PRODUCTION, CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') }),
    );

    expect(error.message).toContain('CREDENTIALS_ENCRYPTION_KEY');
  });

  it('el secreto de la app y el token de verificación se configuran juntos', () => {
    const error = captureError(() =>
      loadConfig({ DATABASE_URL: databaseUrl, WHATSAPP_APP_SECRET: 'secreto-de-la-app' }),
    );

    expect(error.message).toContain('WHATSAPP_VERIFY_TOKEN');
  });

  it('en desarrollo, una variable vacía de .env cuenta como no definida', () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      WHATSAPP_APP_SECRET: '',
      WHATSAPP_VERIFY_TOKEN: '',
      CREDENTIALS_ENCRYPTION_KEY: '',
    });

    expect(config.whatsapp).toBeNull();
    expect(config.credentialsKey).toBeNull();
  });

  it('rechaza una clave de cifrado que no tiene 32 bytes, sin mostrarla', () => {
    const shortKey = Buffer.from('clave-corta-secreta').toString('base64');
    const error = captureError(() =>
      loadConfig({ DATABASE_URL: databaseUrl, CREDENTIALS_ENCRYPTION_KEY: shortKey }),
    );

    expect(error.message).toContain('CREDENTIALS_ENCRYPTION_KEY');
    expect(error.message).not.toContain(shortKey);
  });

  it('falla con ConfigError si falta DATABASE_URL', () => {
    const error = captureError(() => loadConfig({}));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('DATABASE_URL');
  });

  it('falla si DATABASE_URL no es una URL de Postgres', () => {
    const error = captureError(() => loadConfig({ DATABASE_URL: 'mysql://localhost/bots' }));

    expect(error.message).toContain('DATABASE_URL');
  });

  it.each(['0', '65536', 'abc', ''])('falla si PORT es inválido (%j)', (port) => {
    const error = captureError(() => loadConfig({ DATABASE_URL: databaseUrl, PORT: port }));

    expect(error.message).toContain('PORT');
  });

  it('falla si LOG_LEVEL no es un nivel conocido', () => {
    const error = captureError(() => loadConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: 'verbose' }));

    expect(error.message).toContain('LOG_LEVEL');
  });

  it('no filtra la contraseña de la base en el mensaje de error', () => {
    const error = captureError(() => loadConfig({ DATABASE_URL: 'http://postgres:secreta@localhost/bots' }));

    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).not.toContain('secreta');
  });
});
