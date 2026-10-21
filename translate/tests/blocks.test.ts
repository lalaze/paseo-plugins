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
}) => Promise<void>, markup = '') {
  const dom = new JSDOM(`
    <div data-testid="agent-chat-scroll">
      <div data-testid="assistant-message">
        ${markup}
        <div id="reply" data-paseo-markdown-tag="p">Hello <span id="emphasis">world</span></div>
        <div id="outer" data-paseo-markdown-tag="li" data-rect="40,200,360,80">
          <div data-paseo-markdown-list-marker>•</div>
          <div id="outer-content">Dev setup
            <div id="inner-list" data-paseo-markdown-tag="ul">
              <div id="inner" data-paseo-markdown-tag="li" data-rect="70,230,330,44">
                <div data-paseo-markdown-list-marker>•</div>
                <div id="inner-text">Restart the app</div>
              </div>
            </div>
          </div>
        </div>
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
    const [x, y, width, height] = this.dataset.rect?.split(',').map(Number) ?? [isTrigger ? 66 : 100, 100, isTrigger ? 28 : 300, 22];
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

test('semantic Markdown paragraphs expose the hover button and translate in place', async () => {
  await withTranslator(async ({ document, move, calls }) => {
    move('#semantic-emphasis');
    const trigger = document.querySelector<HTMLButtonElement>(triggerSelector);
    assert.ok(trigger, 'the enriched Markdown renderer uses real p elements without legacy data attributes');
    trigger.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [{ text: 'Hello desktop', target: 'auto' }]);
    const panel = document.querySelector('#semantic-reply + [data-paseo-translate-block]');
    assert.equal(panel?.querySelector('[data-paseo-translate-block-text]')?.textContent, '你好，世界');
    move('#semantic-emphasis');
    trigger.click();
    assert.equal((panel as HTMLElement).style.display, 'none');
    trigger.click();
    assert.equal((panel as HTMLElement).style.display, 'flex');
    assert.equal(calls.length, 1);
  }, '<p id="semantic-reply">Hello <strong id="semantic-emphasis">desktop</strong></p>');
});

test('supplemental block controls yield to an existing legacy hover button', async () => {
  await withTranslator(async ({ document, move }) => {
    const legacy = document.createElement('button');
    legacy.dataset.paseoTranslate = 'block-trigger';
    document.body.append(legacy);
    move('#reply');
    assert.equal(document.querySelectorAll(triggerSelector).length, 1);
    assert.equal(document.querySelector(triggerSelector), legacy);
    legacy.remove();
    move('#reply');
    assert.ok(document.querySelector(triggerSelector));
  });
});

test('semantic nested lists translate only the hovered item and keep panels inside the li', async () => {
  await withTranslator(async ({ document, move, calls }) => {
    move('#modern-outer-text', 150, 210);
    document.querySelector<HTMLButtonElement>(triggerSelector)!.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [{ text: 'Outer task', target: 'auto' }]);
    assert.ok(document.querySelector('#modern-outer > [data-paseo-translate-block]'));
    move('#modern-inner-text', 150, 240);
    const trigger = document.querySelector<HTMLButtonElement>(triggerSelector)!;
    move('#modern-list', 50, 245);
    assert.equal(trigger.style.left, '36px');
    trigger.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.map(call => call.text), ['Outer task', 'Inner task']);
    assert.ok(document.querySelector('#modern-inner > [data-paseo-translate-block]'));
    // Reopening the outer item must find its own panel rather than the nested panel.
    move('#modern-outer-text', 150, 210);
    trigger.click();
    assert.equal(document.querySelector<HTMLElement>('#modern-outer > [data-paseo-translate-block]')?.style.display, 'none');
    assert.equal(document.querySelector<HTMLElement>('#modern-inner > [data-paseo-translate-block]')?.style.display, 'flex');
    assert.equal(calls.length, 2);
  }, `<ul><li id="modern-outer" data-rect="40,200,360,80"><span id="modern-outer-text"><input type="checkbox">Outer task</span>
    <ul id="modern-list"><li id="modern-inner" data-rect="70,230,330,44"><span id="modern-inner-text">Inner task</span></li></ul>
  </li></ul>`);
});

test('semantic headings and quotes expose the button while code blocks do not', async () => {
  await withTranslator(async ({ document, move }) => {
    for (const selector of ['#modern-heading', '#modern-quote']) {
      move(selector);
      assert.ok(document.querySelector(triggerSelector), selector);
      document.dispatchEvent(new document.defaultView!.Event('pointerleave'));
    }
    for (const selector of ['#modern-code', '#legacy-code']) {
      move(selector);
      assert.equal(document.querySelector(triggerSelector), null, selector);
    }
  }, `<h2 id="modern-heading">Heading</h2><blockquote><p id="modern-quote">Quoted text</p>
    <pre><code id="modern-code">Code is not a paragraph</code></pre>
    <div data-paseo-markdown-tag="pre"><span id="legacy-code">Legacy code</span></div>
  </blockquote>`);
});

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

test('the button of a nested list item survives crossing the enclosing item\'s indent', async () => {
  await withTranslator(async ({ document, move, calls }) => {
    move('#inner-text', 150, 240);
    const button = document.querySelector<HTMLButtonElement>(triggerSelector);
    assert.ok(button);
    // Left of the nested item, inside the outer item's indent, where the button is placed.
    move('#inner-list', 55, 240);
    move('#outer-content', 50, 245);
    assert.equal(button.style.left, `${70 - 28 - 6}px`);
    button.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [{ text: 'Restart the app', target: 'auto' }]);
    // The outer item's own line still takes the button over.
    move('#outer-content', 150, 210);
    assert.equal(button.style.left, `${40 - 28 - 6}px`);
  });
});
