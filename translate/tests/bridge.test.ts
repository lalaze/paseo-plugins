import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
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

function withCleanBridge(run: () => Promise<void> | void) {
  const registryKey = Symbol.for('lalaze.paseo-translate.registry.v1');
  const bridgeKey = Symbol.for('lalaze.paseo-translate.bridge.v1');
  const holder = globalThis as typeof globalThis & { [registryKey]?: unknown; [bridgeKey]?: unknown };
  const previousRegistry = holder[registryKey];
  const previousBridge = holder[bridgeKey];
  delete holder[registryKey];
  delete holder[bridgeKey];
  const finish = () => {
    if (previousRegistry === undefined) delete holder[registryKey];
    else holder[registryKey] = previousRegistry;
    if (previousBridge === undefined) delete holder[bridgeKey];
    else holder[bridgeKey] = previousBridge;
  };
  try {
    const result = run();
    if (result && typeof (result as Promise<void>).then === 'function') return (result as Promise<void>).finally(finish);
    finish();
  } catch (error) {
    finish();
    throw error;
  }
  return undefined;
}

test('another plugin can translate through the host bridge, and a missing host cannot', async () => {
  await withCleanBridge(async () => {
    const seen: string[] = [];
    const unregister = registerTranslationClient('srv_a', client(text => seen.push(text)));
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
  });
});

test('an older overlay registry does not hide the host bridge', async () => {
  await withCleanBridge(async () => {
    const registryKey = Symbol.for('lalaze.paseo-translate.registry.v1');
    let overlayHosts: string[] = [];
    (globalThis as typeof globalThis & { [registryKey]?: unknown })[registryKey] = {
      closed: false,
      register: (serverId: string) => {
        overlayHosts = [...overlayHosts, serverId];
        return () => { overlayHosts = overlayHosts.filter(id => id !== serverId); };
      },
    };
    const unregister = registerTranslationClient('srv_a', client(() => {}));
    assert.deepEqual(overlayHosts, ['srv_a']);
    assert.equal(translationBridge()?.available('srv_a'), true);
    const translated = await translationBridge()?.translate('srv_a', '你好', 'auto');
    assert.equal(translated?.translation, 'Fix the login');
    unregister();
    assert.deepEqual(overlayHosts, []);
    assert.equal(translationBridge(), null);
  });
});

test('a hot-reloaded host restores semantic block controls while another host keeps the old registry alive', async () => {
  await withCleanBridge(async () => {
    const registryKey = Symbol.for('lalaze.paseo-translate.registry.v1');
    // An earlier plugin bundle owns the shared controller and cannot recognize
    // the enriched renderer's semantic paragraphs. Reloading one host keeps it alive.
    (globalThis as typeof globalThis & { [registryKey]?: unknown })[registryKey] = {
      closed: false,
      register: () => () => {},
    };
    const seenOld: string[] = [], seenNew: string[] = [];
    const stopOld = registerTranslationClient('srv_old', client(text => seenOld.push(text)));
    const dom = new JSDOM('<div data-testid="agent-chat-scroll"><div data-testid="assistant-message"><p id="reply">Hello desktop</p></div></div>', { url: 'https://paseo.test/h/srv_old/workspace/wks' });
    const keys = ['window', 'document', 'Node', 'Element', 'HTMLElement'] as const;
    const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    let stopNew = () => {};
    try {
      stopNew = registerTranslationClient('srv_new', client(text => seenNew.push(text)));
      const paragraph = dom.window.document.querySelector('#reply')!;
      const move = () => paragraph.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true }));
      move();
      const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-paseo-translate="block-trigger"]');
      assert.ok(trigger, 'new semantic block support must not depend on the first host upgrading its registry');
      trigger.click();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(seenOld, ['Hello desktop']);
      assert.deepEqual(seenNew, []);
      assert.equal(dom.window.document.querySelector('[data-paseo-translate-block-text]')?.textContent, 'Fix the login');
      // Several upgraded hosts share one supplemental controller.
      const stopThird = registerTranslationClient('srv_third', client(() => {}));
      stopNew(); stopNew = () => {};
      move();
      assert.equal(dom.window.document.querySelectorAll('[data-paseo-translate="block-trigger"]').length, 1);
      stopThird();
      assert.equal(dom.window.document.querySelector('[data-paseo-translate="block-trigger"]'), null);
    } finally {
      stopNew(); stopOld(); dom.window.close();
      keys.forEach((key, index) => {
        if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
        else Reflect.deleteProperty(globalThis, key);
      });
    }
  });
});
