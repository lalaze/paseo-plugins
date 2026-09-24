import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { act, createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReplyTranslationProps } from '../client/reply-translation';
import type { TranslationResult } from '../shared/rpc';

test('reply button translates only on demand, folds without another request, copies and retries errors', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const compiled = await build({
    stdin: { contents: "export { ReplyTranslator } from './client/reply-translator'; export { harness } from 'test-runtime';", resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
    plugins: [{ name: 'native-test-runtime', setup(builder) {
      builder.onResolve({ filter: /^(react-native|test-runtime|@getpaseo\/plugin\/client(?:\/react-native)?)$/ }, args => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ loader: 'js', contents: path === 'react-native' ? `
        import { createElement } from 'react';
        export const View = ({ children }) => createElement('div', {}, children);
        export const Text = ({ children }) => createElement('span', {}, children);
        export const Pressable = ({ children, disabled, onPress }) => createElement('button', { disabled, onClick: onPress }, children);
      ` : path === 'test-runtime' ? `
        export const harness = { translate: null, copied: '' };
      ` : path.endsWith('/react-native') ? `
        import { harness } from 'test-runtime';
        export async function copyText(value) { harness.copied = value; }
      ` : `
        import { harness } from 'test-runtime';
        export function useRpc() { return input => harness.translate(input); }
        export function useSettings() { return { status: 'ready', values: { apiUrl: 'https://example.test/v1/chat/completions', apiKey: '', model: 'test' } }; }
      ` }));
    } }],
  });
  const loaded = { exports: {} as {
    ReplyTranslator: ComponentType<ReplyTranslationProps & { openSettings(): void }>;
    harness: { translate(input: { text: string; target: string }): Promise<TranslationResult>; copied: string };
  } };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
  const { ReplyTranslator, harness } = loaded.exports;
  const root = createRoot(dom.window.document.getElementById('root')!);
  const calls: { text: string; target: string }[] = [];
  let fail = false;
  harness.translate = async input => {
    calls.push(input);
    if (fail) throw new Error('offline');
    return { translation: `译文 ${calls.length}`, target: 'zh-CN', detectedLanguage: 'en', note: null, model: 'test' };
  };
  const props = {
    agentId: 'agent', timestamp: new Date(), host: { id: 'host', label: 'host' }, layout: { compact: true, platform: 'android' },
    theme: { colors: {} }, item: { type: 'plugin', kind: 'reply-translation', version: 1, data: { text: 'x'.repeat(6000) } }, openSettings() {},
  } as ReplyTranslationProps & { openSettings(): void };
  const buttons = () => [...dom.window.document.querySelectorAll('button')];
  try {
    await act(async () => root.render(createElement(ReplyTranslator, props)));
    assert.equal(calls.length, 0);
    assert.equal(buttons().length, 1);
    await act(async () => buttons()[0].click());
    assert.equal(calls.length, 2);
    assert.equal(calls.map(call => call.text).join(''), props.item.data.text);
    assert.ok(calls.every(call => call.target === 'zh-CN'));
    assert.match(dom.window.document.body.textContent!, /译文 1\s+译文 2/);
    await act(async () => buttons()[1].click());
    assert.equal(harness.copied, '译文 1\n\n译文 2');
    await act(async () => buttons()[0].click());
    assert.doesNotMatch(dom.window.document.body.textContent!, /译文 1/);
    await act(async () => buttons()[0].click());
    assert.equal(calls.length, 2);
    assert.match(dom.window.document.body.textContent!, /译文 1/);

    fail = true;
    await act(async () => root.render(createElement(ReplyTranslator, { ...props, key: 'other', item: { ...props.item, data: { text: 'another reply' } } })));
    await act(async () => buttons()[0].click());
    assert.match(dom.window.document.body.textContent!, /offline/);
    fail = false;
    await act(async () => buttons()[0].click());
    assert.doesNotMatch(dom.window.document.body.textContent!, /offline/);
    assert.match(dom.window.document.body.textContent!, /译文 4/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
