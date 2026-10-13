import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createWordCache, createWordTranslator, englishWordAt, wordAtPoint } from '../client/words';
import { setWordTranslationEnabled, wordTranslationEnabled } from '../client/word-preference';
import type { TranslationResult } from '../shared/rpc';

const result = (translation: string): TranslationResult => ({ translation, target: 'zh-CN', detectedLanguage: null, note: null, model: 'test' });
const settle = () => new Promise(resolve => setTimeout(resolve, 340));
const bubbleSelector = '[data-paseo-translate="word"]';

test('English tokens include contractions and hyphens, reject numbers and non-English alphabets', () => {
  for (const text of ['hello', 'I', "don't", 'you’re', 'well-known', 'GPT']) {
    assert.equal(englishWordAt(text, 1)?.text, text);
  }
  for (const text of ['中文', '123', 'foo_bar', 'abc123', 'café', 'cafe\u0301', 'helloЖ', 'Жhello']) {
    assert.equal(englishWordAt(text, 1), null, text);
  }
  assert.equal(englishWordAt('中文hello中文', 4)?.text, 'hello');
  assert.equal(englishWordAt('hello   world', 7), null);
});

test('word cache deduplicates requests, invalidates settings, retries failures and bounds memory', async () => {
  const cache = createWordCache();
  let calls = 0;
  const request = async () => { calls++; return result('你好'); };
  await Promise.all([cache('a', 'hello', request), cache('a', 'hello', request)]);
  assert.equal(calls, 1);
  await cache('b', 'hello', request);
  assert.equal(calls, 2);
  await assert.rejects(cache('b', 'fail', async () => { throw new Error('offline'); }));
  assert.equal((await cache('b', 'fail', request)).translation, '你好');
  for (let i = 0; i < 101; i++) await cache('b', String(i), request);
  const before = calls;
  await cache('b', 'hello', request);
  assert.equal(calls, before + 1);
});

async function fixture(run: (context: {
  document: Document; window: JSDOM['window'];
  click(selector: string, options?: { detail?: number; shiftKey?: boolean; drag?: boolean; offset?: number }): void;
  setCaret(node: Node, offset: number): void;
  requests: { text: string; resolve(value: TranslationResult): void; reject(error: Error): void }[];
  dispose(): void;
}) => Promise<void>) {
  const dom = new JSDOM(`<div data-testid="agent-chat-scroll"><div data-testid="assistant-message"><p id="hello">hello</p><p id="world">world</p><p id="mixed">中文hello中文</p><p id="split">un<strong id="strong">believ</strong>able</p><p><a id="link">hello</a><code id="code">hello</code><span data-paseo-markdown-tag="code" id="rncode">hello</span><button id="button">hello</button></p></div></div><p id="outside">hello</p>`, { url: 'https://paseo.test/h/server/agent/agent' });
  const { window } = dom;
  const document = window.document;
  const keys = ['window', 'document', 'Node', 'Element', 'MutationObserver'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  keys.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, value: window[key] }));
  let caretNode: Node = document.querySelector('#hello')!.firstChild!, caretOffset = 2;
  Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: caretNode, offset: caretOffset }) });
  window.Range.prototype.getClientRects = () => [{ left: 10, right: 110, top: 10, bottom: 30, width: 100, height: 20 }] as unknown as DOMRectList;
  const requests: { text: string; resolve(value: TranslationResult): void; reject(error: Error): void }[] = [];
  const controller = createWordTranslator(new Map([['server', { translate: (text, target) => {
    assert.equal(target, 'zh-CN');
    return new Promise<TranslationResult>((resolve, reject) => { requests.push({ text, resolve, reject }); });
  } }]]));
  const click = (selector: string, options: { detail?: number; shiftKey?: boolean; drag?: boolean; offset?: number } = {}) => {
    const target = document.querySelector(selector)!;
    caretNode = target.firstChild!; caretOffset = options.offset ?? 2;
    target.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: options.drag ? 40 : 20, clientY: 20 }));
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0, detail: options.detail ?? 1, clientX: 20, clientY: 20, shiftKey: options.shiftKey }));
  };
  try { await run({ document, window, click, setCaret(node, offset) { caretNode = node; caretOffset = offset; }, requests, dispose: controller.dispose }); }
  finally {
    controller.dispose(); window.close();
    keys.forEach((key, index) => { if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!); else Reflect.deleteProperty(globalThis, key); });
  }
}

test('point lookup crosses inline Markdown, supports the WebKit fallback and rejects whitespace hits', async () => {
  await fixture(async ({ document, setCaret }) => {
    const target = document.querySelector('#strong')!;
    setCaret(target.firstChild!, 2);
    assert.equal(wordAtPoint(target, 20, 20)?.text, 'unbelievable');
    assert.equal(wordAtPoint(target, 200, 20), null);
    Object.defineProperty(document, 'caretPositionFromPoint', { value: undefined });
    Object.defineProperty(document, 'caretRangeFromPoint', { value: () => {
      const range = document.createRange(); range.setStart(target.firstChild!, 2); return range;
    } });
    assert.equal(wordAtPoint(target, 20, 20)?.text, 'unbelievable');
  });
});

test('click highlights without selecting, delays the bubble, ignores stale replies and clears with Escape', async () => {
  await fixture(async ({ document, window, click, requests }) => {
    click('#hello');
    assert.equal(document.querySelector(bubbleSelector), null);
    assert.ok(document.querySelector('[data-paseo-translate="word-highlight"]'));
    assert.equal(window.getSelection()!.isCollapsed, true);
    assert.equal(requests.length, 0);
    await settle();
    click('#world'); await settle();
    assert.deepEqual(requests.map(item => item.text), ['hello', 'world']);
    requests[1].resolve(result('世界')); await Promise.resolve();
    requests[0].resolve(result('你好')); await Promise.resolve();
    assert.match(document.querySelector(bubbleSelector)!.textContent!, /世界/);
    assert.doesNotMatch(document.querySelector(bubbleSelector)!.textContent!, /你好/);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.querySelector(bubbleSelector), null);
    assert.equal(document.querySelector('[data-paseo-translate="word-highlight"]'), null);
  });
});

test('links, code, controls, outside messages, modifiers, drags and double clicks do not translate', async () => {
  await fixture(async ({ document, click, requests }) => {
    for (const selector of ['#link', '#code', '#rncode', '#button', '#outside']) {
      click(selector); assert.equal(document.querySelector(bubbleSelector), null, selector);
    }
    click('#hello', { shiftKey: true }); assert.equal(document.querySelector(bubbleSelector), null);
    click('#hello', { drag: true }); assert.equal(document.querySelector(bubbleSelector), null);
    click('#hello'); click('#hello', { detail: 2 });
    assert.equal(document.querySelector(bubbleSelector), null);
    assert.equal(document.querySelector('[data-paseo-translate="word-highlight"]'), null);
    await settle(); assert.equal(requests.length, 0);
  });
});

test('clicking to collapse a previous selection does not translate; moving away and back is still a drag', async () => {
  await fixture(async ({ document, window, requests }) => {
    const target = document.querySelector('#hello')!;
    const range = document.createRange(); range.selectNodeContents(target);
    window.getSelection()!.addRange(range);
    const down = () => target.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
    const up = () => target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0, detail: 1, clientX: 20, clientY: 20 }));
    down();
    // Model the browser's default mousedown behaviour, after capture listeners.
    window.getSelection()!.removeAllRanges(); up();
    assert.equal(document.querySelector('[data-paseo-translate="word-highlight"]'), null);
    down();
    target.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 20 }));
    target.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 20 }));
    up(); await settle();
    assert.equal(requests.length, 0);
    assert.equal(document.querySelector(bubbleSelector), null);
  });
});

test('turning word translation off cancels highlights, pending work and late replies without touching selections', async () => {
  await fixture(async ({ document, window, click, requests }) => {
    assert.equal(wordTranslationEnabled(), true);
    click('#hello'); setWordTranslationEnabled(false);
    assert.equal(wordTranslationEnabled(), false);
    assert.equal(document.querySelector('[data-paseo-translate="word-highlight"]'), null);
    click('#world'); await settle(); assert.equal(requests.length, 0);
    setWordTranslationEnabled(true);
    click('#hello'); await settle(); assert.equal(requests.length, 1);
    setWordTranslationEnabled(false);
    requests[0].resolve(result('你好')); await Promise.resolve();
    assert.equal(document.querySelector(bubbleSelector), null);
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#world')!);
    window.getSelection()!.addRange(range);
    setWordTranslationEnabled(true);
    assert.equal(window.getSelection()!.toString(), 'world');
  });
});

test('native CSS highlights do not rewrite text or use the browser selection', async () => {
  await fixture(async ({ document, window, click }) => {
    const marks = new Map<string, unknown>();
    Object.defineProperty(window, 'CSS', { configurable: true, value: { highlights: marks } });
    Object.defineProperty(window, 'Highlight', { configurable: true, value: class { constructor(public range: Range) {} } });
    const original = document.querySelector('#hello')!.innerHTML;
    click('#hello');
    assert.equal(marks.size, 1);
    assert.equal(document.querySelector('#hello')!.innerHTML, original);
    assert.equal(window.getSelection()!.isCollapsed, true);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(marks.size, 0);
    assert.equal(document.head.querySelector('style'), null);
  });
});

test('selection and scrolling cancel pending requests; removal and route changes discard replies', async () => {
  await fixture(async ({ document, window, click, requests }) => {
    click('#hello');
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#hello')!);
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new window.Event('selectionchange'));
    assert.equal(document.querySelector(bubbleSelector), null);
    window.getSelection()!.removeAllRanges();
    click('#hello'); document.dispatchEvent(new window.Event('scroll'));
    await settle(); assert.equal(requests.length, 0);
    click('#hello'); await settle();
    document.querySelector('#hello')!.remove(); await Promise.resolve();
    assert.equal(document.querySelector(bubbleSelector), null);
    requests[0].resolve(result('你好')); await Promise.resolve();
    click('#world'); await settle();
    window.history.pushState({}, '', '/h/server/agent/other');
    requests[1].resolve(result('世界')); await Promise.resolve();
    assert.equal(document.querySelector(bubbleSelector), null);
  });
});

test('errors appear in the bubble and dispose removes listeners and timers', async () => {
  await fixture(async ({ document, click, requests, dispose }) => {
    click('#hello'); await settle();
    requests[0].reject(new Error('offline')); await Promise.resolve();
    assert.match(document.querySelector(bubbleSelector)!.textContent!, /offline/);
    click('#world'); dispose(); await settle();
    click('#hello'); assert.equal(document.querySelector(bubbleSelector), null);
    assert.equal(requests.length, 1);
  });
});
