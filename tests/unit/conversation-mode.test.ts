import { describe, expect, it } from 'vitest';
import { chooseConversationMode } from '../../src/conversation-mode.js';

const KEY = Buffer.alloc(32, 7);

describe('chooseConversationMode: cuándo el worker contesta conversaciones', () => {
  it('con las dos claves, contesta el agente: también en producción, desde H8 (hay derivación a una persona)', () => {
    expect(chooseConversationMode({ credentialsKey: KEY, anthropicApiKey: 'sk-ant-x' })).toEqual({
      kind: 'agent',
      credentialsKey: KEY,
      anthropicApiKey: 'sk-ant-x',
    });
  });

  it('sin clave de cifrado no puede enviar mensajes', () => {
    expect(chooseConversationMode({ credentialsKey: null, anthropicApiKey: 'sk-ant-x' })).toEqual({
      kind: 'disabled',
      reason: 'missing_credentials_key',
    });
  });

  it('sin ANTHROPIC_API_KEY no contesta', () => {
    expect(chooseConversationMode({ credentialsKey: KEY, anthropicApiKey: null })).toEqual({
      kind: 'disabled',
      reason: 'missing_anthropic_key',
    });
  });
});
