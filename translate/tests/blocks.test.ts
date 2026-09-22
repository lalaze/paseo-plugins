import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBlockTranslator } from '../client/blocks';
import type { TargetLanguage } from '../shared/rpc';

const triggerSelector = '[data-paseo-translate="block-trigger"]';

async function withTranslator(run: (harness: {
  document: Document;
  move(selector: string, x?: number, y?: number): void;
  calls: { text: string; target: TargetLanguage }[];
}) => Promise<void>) {
  const dom = new JSDOM(`
    <div data-testid="agent-chat-scroll">
      <div data-testid="assistant-message">
        <div id="reply" data-paseo-markdown-tag="p">Hello <span id="emphasis">world</span></div>
      </div>
      <div id="user" data-testid="user-message">
        <div id="user-text" dir="auto">当前这套 vllm 是多少 t/s？</div>
        <div id="user-markdown" data-paseo-markdown-tag="p">My formatted message</div>
        <div id="user-actions" data-testid="user-message-trailing-row">11:33</div>
      </div>
    </div>
  `, { url: 'https://paseo.test/h/server/agent/agent' });
  const keys = ['window', 'document', 'Node', 'Element', 'HTMLElement'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const isTrigger = this.matches(triggerSelector);
    const x = isTrigger ? 66 : 100, y = 100, width = isTrigger ? 28 : 300, height = 22;
    return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() { return {}; } };
  };
  const calls: { text: string; target: TargetLanguage }[] = [];
  const translator = createBlockTranslator(new Map([['server', {
    translate: async (text: string, target: TargetLanguage) => {
      calls.push({ text, target });
      return { translation: '你好，世界', detectedLanguage: 'en', target: 'zh-CN' as const, note: null, model: 'test' };
    },
  }]]));
  try {
    await run({
      document: dom.window.document,
      calls,
      move(selector, x = 150, y = 110) {
        const target = dom.window.document.querySelector(selector);
        assert.ok(target);
        target.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
      },
    });
  } finally {
    translator.dispose();
    dom.window.close();
    keys.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

test('hovering user messages never shows a block translation button', async () => {
  await withTranslator(async ({ document, move, calls }) => {
    for (const selector of ['#user-text', '#user-markdown', '#user-actions', '#user']) {
      move(selector);
      assert.equal(document.querySelector(triggerSelector), null, selector);
    }
    assert.deepEqual(calls, []);
  });
});

test('moving from an assistant paragraph to any user message area hides the button even within hover slack', async () => {
  await withTranslator(async ({ document, move }) => {
    for (const selector of ['#user-text', '#user-markdown', '#user-actions', '#user']) {
      move('#reply');
      assert.ok(document.querySelector(triggerSelector));
      // Just below the paragraph, inside the 12px gap tolerance.
      move(selector, 150, 128);
      assert.equal(document.querySelector(triggerSelector), null, selector);
    }
  });
});

test('assistant paragraphs still translate on click and the button survives crossing the gap', async () => {
  await withTranslator(async ({ document, move, calls }) => {
    move('#emphasis');
    const button = document.querySelector<HTMLButtonElement>(triggerSelector);
    assert.ok(button);
    assert.deepEqual(calls, []);
    move('[data-testid="agent-chat-scroll"]', 97, 110);
    assert.equal(document.querySelector(triggerSelector), button);
    move(triggerSelector, 80, 110);
    button.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [{ text: 'Hello world', target: 'auto' }]);
    assert.equal(document.querySelector('#reply + [data-paseo-translate-block] [data-paseo-translate-block-text]')?.textContent, '你好，世界');
    assert.equal(document.querySelector('#user [data-paseo-translate-block]'), null);
  });
});
