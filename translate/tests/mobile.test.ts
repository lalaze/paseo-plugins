import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { act, createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import type { ComposerTranslator } from '../client/composer';
import type { ReplyTranslator } from '../client/reply-translator';
import type { useTranslation } from '../client/use-translation';
import type { TranslationResult } from '../shared/rpc';

const translation = (value: string): TranslationResult => ({ translation: value, target: 'zh-CN', detectedLanguage: 'en', note: null, model: 'test' });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function withMobile(run: (runtime: {
  Composer: typeof ComposerTranslator; Reply: typeof ReplyTranslator; Probe: ComponentType;
  harness: {
    translate(input: { text: string; target: string }): Promise<TranslationResult>;
    copied: string; state: ReturnType<typeof useTranslation>;
    revision: string;
  };
  render(element: ReturnType<typeof createElement>): Promise<void>;
  document: Document; dom: JSDOM;
  button(label: RegExp): HTMLButtonElement;
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, __PASEO_LOCALE__: 'zh-CN' };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    const compiled = await build({
      stdin: { contents: `
        import { useTranslation } from './client/use-translation';
        import { harness } from 'test-runtime';
        export { harness };
        export { ComposerTranslator as Composer } from './client/composer';
        export { ReplyTranslator as Reply } from './client/reply-translator';
        export function Probe() { harness.state = useTranslation(); return null; }
      `, resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' },
      bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
      plugins: [{ name: 'mobile-runtime', setup(builder) {
        builder.onResolve({ filter: /^(react-native|test-runtime|@getpaseo\/plugin\/client(?:\/react-native)?)$/ }, args => ({ path: args.path, namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ loader: 'js', contents: path === 'react-native' ? `
          import { createElement } from 'react';
          export const View = ({ children }) => createElement('div', {}, children);
          export const ScrollView = View;
          export const Text = ({ children }) => createElement('span', {}, children);
          export const Pressable = ({ children, disabled, onPress, accessibilityLabel }) => createElement('button', { disabled, onClick: onPress, 'aria-label': accessibilityLabel }, typeof children === 'function' ? children({ pressed: false }) : children);
          export const ActivityIndicator = () => null;
          export const TextInput = ({ value, onChangeText, editable, accessibilityLabel }) => createElement('textarea', {
            value, onInput: event => onChangeText(event.target.value), disabled: editable === false, 'aria-label': accessibilityLabel,
          });
        ` : path === 'test-runtime' ? `
          export const harness = { translate: null, copied: '', state: null, revision: '1' };
        ` : path.endsWith('/react-native') ? `
          import { harness } from 'test-runtime';
          export { ScrollView, TextInput } from 'react-native';
          export const Icon = () => null;
          export async function copyText(value) { harness.copied = value; }
          export function useToast() { return { show() {} }; }
        ` : `
          import { harness } from 'test-runtime';
          export function useRpc() { return input => harness.translate(input); }
          export function useSettings() { return { status: 'ready', revision: harness.revision, values: { apiUrl: 'https://example.test/v1/chat/completions', apiKey: '', model: 'test' } }; }
          export function useAgent() { return false; }
        ` }));
      } }],
    });
    const loaded = { exports: {} as Pick<Parameters<typeof run>[0], 'Composer' | 'Reply' | 'Probe' | 'harness'> };
    new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
    await run({ ...loaded.exports, dom, document: dom.window.document,
      render: async element => { await act(async () => root.render(element)); },
      button: label => {
        const button = [...dom.window.document.querySelectorAll('button')].find(element => label.test(element.textContent ?? '') || label.test(element.getAttribute('aria-label') ?? ''));
        assert.ok(button, `Missing button ${label}`);
        return button;
      },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const hostProps = {
  host: { id: 'host', label: 'host' }, layout: { compact: true, platform: 'android' }, theme: { colors: {} },
};

test('native sheet preserves drafts, translates full latest replies and sends only draft translations', async () => {
  await withMobile(async ({ Composer, harness, render, button, document, dom }) => {
    const calls: { text: string; target: string }[] = [];
    const sent: string[] = [];
    const text = 'latest reply '.repeat(1000);
    const props = { ...hostProps, context: 'agent', workspaceId: 'workspace', agentId: 'agent', close() {}, openSettings() {}, paseo: { agents: { ref: () => ({
      timeline: { refetch: async () => ({ entries: [{ item: { type: 'assistant_message', text } }] }) },
      send: async (value: string) => { sent.push(value); },
    }) } } } as unknown as Parameters<typeof Composer>[0];
    harness.translate = async input => { calls.push(input); return translation(`translated ${calls.length}`); };
    await render(createElement(Composer, props));
    assert.equal(calls.length, 0);
    assert.doesNotMatch(document.body.textContent!, /日语/);
    await act(async () => button(/^更多$/).click());
    assert.match(document.body.textContent!, /日语/);
    const input = document.querySelector('textarea')!;
    await act(async () => { input.value = 'my draft'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await act(async () => { button(/^翻译消息$/).click(); button(/^翻译消息$/).click(); });
    assert.equal(calls.length, 1);
    assert.equal(sent.length, 0);
    await act(async () => button(/^读回复$/).click());
    assert.equal(document.querySelector('textarea'), null);
    await act(async () => button(/^翻译最新回复$/).click());
    const replyCalls = calls.slice(1);
    assert.equal(replyCalls.map(call => call.text).join(''), text.trim());
    assert.ok(replyCalls.every(call => call.text.length <= 5000 && call.target === 'zh-CN'));
    assert.match(document.body.textContent!, /3 段已全部翻译/);
    assert.doesNotMatch(document.body.textContent!, /发送译文/);
    assert.equal(sent.length, 0);
    await act(async () => button(/^复制$/).click());
    assert.equal(harness.copied, 'translated 2\n\ntranslated 3\n\ntranslated 4');
    await act(async () => button(/^翻译最新回复$/).click());
    assert.equal(calls.length, 4, 'unchanged latest reply uses the completed translation');
    await act(async () => button(/^写消息$/).click());
    assert.equal(document.querySelector('textarea')!.value, 'my draft');
    assert.match(document.body.textContent!, /translated 1/);
    await act(async () => { button(/^发送译文$/).click(); button(/^发送译文$/).click(); });
    assert.deepEqual(sent, ['translated 1']);
  });
});

test('long reply displays partial progress and resumes at the failed chunk without repeating earlier calls', async () => {
  await withMobile(async ({ Reply, harness, render, button, document }) => {
    const calls: string[] = [];
    const second = deferred<TranslationResult>();
    harness.translate = async input => {
      calls.push(input.text);
      return calls.length === 1 ? translation('first part') : calls.length === 2 ? second.promise : translation('second part');
    };
    const props = { ...hostProps, agentId: 'agent', timestamp: new Date(), item: { type: 'plugin', kind: 'reply-translation', version: 1, data: { text: 'a'.repeat(5000) + 'b'.repeat(1000) } }, openSettings() {} } as Parameters<typeof Reply>[0];
    await render(createElement(Reply, props));
    await act(async () => button(/^翻译$/).click());
    assert.match(document.body.textContent!, /翻译中 · 1\/2 段/);
    assert.match(document.body.textContent!, /first part/);
    assert.equal(button(/^复制译文$/).disabled, true);
    await act(async () => second.reject(new Error('offline')));
    assert.match(document.body.textContent!, /offline/);
    assert.match(document.body.textContent!, /first part/);
    await act(async () => button(/^继续翻译$/).click());
    assert.deepEqual(calls, ['a'.repeat(5000), 'b'.repeat(1000), 'b'.repeat(1000)]);
    assert.match(document.body.textContent!, /2 段已全部翻译/);
    assert.doesNotMatch(document.body.textContent!, /offline/);
    await act(async () => button(/^复制译文$/).click());
    assert.equal(harness.copied, 'first part\n\nsecond part');
  });
});

test('source edits invalidate pending translations and do not let an old response overwrite the new result', async () => {
  await withMobile(async ({ Probe, harness, render }) => {
    const first = deferred<TranslationResult>();
    let calls = 0;
    harness.translate = async () => ++calls === 1 ? first.promise : translation('new result');
    await render(createElement(Probe));
    await act(async () => harness.state.setSource('old source'));
    let pending!: Promise<void>;
    await act(async () => { pending = harness.state.run(); void harness.state.run(); });
    assert.equal(calls, 1);
    await act(async () => harness.state.setSource('new source'));
    await act(async () => { await harness.state.run(); });
    await act(async () => { first.resolve(translation('old result')); await pending; });
    assert.equal(harness.state.result?.translation, 'new result');
    assert.equal(harness.state.complete, true);
  });
});

test('changing API settings discards partial results before retrying', async () => {
  await withMobile(async ({ Probe, harness, render }) => {
    let calls = 0;
    harness.translate = async () => {
      if (++calls === 2) throw new Error('offline');
      return translation(`result ${calls}`);
    };
    await render(createElement(Probe));
    await act(async () => { await harness.state.runReply('a'.repeat(6000)); });
    assert.equal(harness.state.progress?.completed, 1);
    harness.revision = '2';
    await render(createElement(Probe));
    await act(async () => { await harness.state.runReply('a'.repeat(6000)); });
    assert.equal(calls, 4);
    assert.equal(harness.state.result?.translation, 'result 3\n\nresult 4');
  });
});

test('closing the sheet during reply loading prevents a subsequent translation request', async () => {
  await withMobile(async ({ Composer, harness, render, button }) => {
    const page = deferred<{ entries: { item: { type: string; text: string } }[] }>();
    let calls = 0;
    harness.translate = async () => { calls++; return translation('result'); };
    const props = { ...hostProps, context: 'agent', workspaceId: 'workspace', agentId: 'agent', close() {}, openSettings() {}, paseo: { agents: { ref: () => ({ timeline: { refetch: () => page.promise } }) } } } as unknown as Parameters<typeof Composer>[0];
    await render(createElement(Composer, props));
    await act(async () => button(/^读回复$/).click());
    await act(async () => button(/^翻译最新回复$/).click());
    await render(createElement('div'));
    await act(async () => page.resolve({ entries: [{ item: { type: 'assistant_message', text: 'reply' } }] }));
    assert.equal(calls, 0);
  });
});
