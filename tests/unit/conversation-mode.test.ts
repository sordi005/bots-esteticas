import { describe, expect, it } from 'vitest';
import { chooseConversationMode } from '../../src/conversation-mode.js';

const KEY = Buffer.alloc(32, 7);

describe('chooseConversationMode: cuándo el worker contesta conversaciones', () => {
  it('en producción no procesa conversaciones, aunque tenga todo configurado: falta la derivación (H8)', () => {
    expect(
      chooseConversationMode({ nodeEnv: 'production', credentialsKey: KEY, anthropicApiKey: 'sk-ant-x' }),
    ).toEqual({ kind: 'disabled', reason: 'production' });
  });

  it('en desarrollo, sin clave de cifrado no puede enviar mensajes', () => {
    expect(
      chooseConversationMode({ nodeEnv: 'development', credentialsKey: null, anthropicApiKey: 'sk-ant-x' }),
    ).toEqual({ kind: 'disabled', reason: 'missing_credentials_key' });
  });

  it('en desarrollo, sin ANTHROPIC_API_KEY no contesta', () => {
    expect(
      chooseConversationMode({ nodeEnv: 'development', credentialsKey: KEY, anthropicApiKey: null }),
    ).toEqual({ kind: 'disabled', reason: 'missing_anthropic_key' });
  });

  it('en desarrollo con las dos claves, contesta el agente', () => {
    expect(
      chooseConversationMode({ nodeEnv: 'development', credentialsKey: KEY, anthropicApiKey: 'sk-ant-x' }),
    ).toEqual({ kind: 'agent', credentialsKey: KEY, anthropicApiKey: 'sk-ant-x' });
  });

  it('en test se comporta como desarrollo', () => {
    expect(
      chooseConversationMode({ nodeEnv: 'test', credentialsKey: KEY, anthropicApiKey: 'sk-ant-x' }).kind,
    ).toBe('agent');
  });
});
