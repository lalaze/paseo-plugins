import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { registerTranslationClient, translationBridge } from '../client/selection';

const settings = {
  apiUrl: 'https://translate.example/v1/chat/completions',
  apiKey: 'secret',
  model: 'translate-model',
  fallbackApiUrl: '',
  fallbackApiKey: '',
  fallbackModel: '',
  englishLockModels: '',
};

function client(onTranslate: (text: string) => void): PluginClientContext {
  return {
    rpc: async (contract: { name: string }, input: unknown) => {
      if (contract.name === 'settings.api.read') return { status: 'ready', revision: '1', values: settings };
      if (contract.name === 'translate.selection') {
        onTranslate((input as { text: string }).text);
        return { translation: 'Fix the login', detectedLanguage: 'zh-CN', target: 'en', note: null, model: 'translate-model' };
      }
      throw new Error(contract.name);
    },
    paseo: { agents: { ref: () => ({ current: () => null, refresh: async () => null }), subscribe: () => () => {} } },
  } as unknown as PluginClientContext;
}

test('another plugin can translate through the host bridge, and a missing host cannot', async () => {
  const key = Symbol.for('lalaze.paseo-translate.registry.v1');
  const previous = (globalThis as { [key]?: unknown })[key];
  const seen: string[] = [];
  const unregister = registerTranslationClient('srv_a', client(text => seen.push(text)));
  try {
    const bridge = translationBridge();
    assert.ok(bridge);
    assert.equal(bridge.available('srv_a'), true);
    assert.equal(bridge.available('srv_b'), false);
    assert.equal(bridge.translate('srv_b', '你好', 'auto'), null);
    const result = await bridge.translate('srv_a', '你好', 'auto');
    assert.deepEqual(seen, ['你好']);
    assert.equal(result?.translation, 'Fix the login');
    let notices = 0;
    const stop = bridge.subscribe(() => { notices += 1; });
    unregister();
    stop();
    assert.equal(notices, 1);
    assert.equal(translationBridge(), null);
  } finally {
    const holder = globalThis as { [key]?: unknown };
    if (previous === undefined) delete holder[key];
    else holder[key] = previous;
  }
});
