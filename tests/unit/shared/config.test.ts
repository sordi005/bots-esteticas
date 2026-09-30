import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/shared/config.js';

const databaseUrl = 'postgres://postgres:secreta@localhost:5434/bots_esteticas';

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
    });
  });

  it('lee los valores del entorno y convierte PORT a número', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      DATABASE_URL: databaseUrl,
    });

    expect(config).toEqual({
      nodeEnv: 'production',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'warn',
      databaseUrl,
    });
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
