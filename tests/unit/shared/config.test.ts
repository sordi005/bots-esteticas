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
      whatsappTestRecipient: null,
      anthropicApiKey: null,
      anthropicModel: 'claude-haiku-5-5',
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
      whatsapp: { appSecret: 'secreto-de-la-app', verifyToken: 'token-de-verificacion', graphApiVersion: 'v26.0' },
      whatsappTestRecipient: null,
      anthropicApiKey: null,
      anthropicModel: 'claude-haiku-5-5',
    });
  });

  it('en desarrollo lee el destino de prueba de WhatsApp (sección 8.1)', () => {
    const config = loadConfig({ DATABASE_URL: databaseUrl, WHATSAPP_TEST_RECIPIENT: '54261155550000' });

    expect(config.whatsappTestRecipient).toBe('54261155550000');
  });

  it('el destino de prueba son solo dígitos, como figura en la lista de Meta', () => {
    const error = captureError(() =>
      loadConfig({ DATABASE_URL: databaseUrl, WHATSAPP_TEST_RECIPIENT: '+54 261 15 536-2239' }),
    );

    expect(error.message).toContain('WHATSAPP_TEST_RECIPIENT');
  });

  it('en producción no se acepta un destino de prueba: mandaría todo a un solo número', () => {
    const error = captureError(() =>
      loadConfig({ ...PRODUCTION, WHATSAPP_TEST_RECIPIENT: '54261155550000' }),
    );

    expect(error.message).toContain('WHATSAPP_TEST_RECIPIENT');
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

  describe('modelo de IA (8.5)', () => {
    it('lee la clave y el modelo del entorno', () => {
      const config = loadConfig({
        DATABASE_URL: databaseUrl,
        ANTHROPIC_API_KEY: 'sk-ant-clave-de-prueba',
        ANTHROPIC_MODEL: 'claude-sonnet-5-5',
      });

      expect(config.anthropicApiKey).toBe('sk-ant-clave-de-prueba');
      expect(config.anthropicModel).toBe('claude-sonnet-5-5');
    });

    it('sin ANTHROPIC_MODEL usa Claude Haiku 5.5, y sin clave el valor es null', () => {
      const config = loadConfig({ DATABASE_URL: databaseUrl });

      expect(config.anthropicModel).toBe('claude-haiku-5-5');
      expect(config.anthropicApiKey).toBeNull();
    });

    it('en .env, una clave o un modelo vacíos cuentan como no definidos', () => {
      const config = loadConfig({ DATABASE_URL: databaseUrl, ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '' });

      expect(config.anthropicApiKey).toBeNull();
      expect(config.anthropicModel).toBe('claude-haiku-5-5');
    });

    it('no es obligatoria en producción: ahí no se procesan conversaciones hasta H8', () => {
      const config = loadConfig(PRODUCTION);

      expect(config.nodeEnv).toBe('production');
      expect(config.anthropicApiKey).toBeNull();
    });

    it('un modelo en blanco se rechaza sin mostrar la clave en el mensaje', () => {
      const error = captureError(() =>
        loadConfig({ DATABASE_URL: databaseUrl, ANTHROPIC_API_KEY: 'sk-ant-secreta', ANTHROPIC_MODEL: '   ' }),
      );

      expect(error.message).toContain('ANTHROPIC_MODEL');
      expect(error.message).not.toContain('sk-ant-secreta');
    });
  });
});
