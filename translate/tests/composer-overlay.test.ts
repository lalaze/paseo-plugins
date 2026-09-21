import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createOverlayController } from '../client/selection';

const controls = '[data-paseo-translate="launcher"], [data-paseo-translate="english-guard"]';
const composer = '<div data-testid="message-input-root"><textarea placeholder="Message"></textarea></div>';
const fileEditor = '<div class="cm-editor"><textarea>文件内容</textarea></div>';

async function withOverlay(html: string, run: (document: Document, overlay: ReturnType<typeof createOverlayController>) => Promise<void>) {
  const dom = new JSDOM(html, { url: 'https://paseo.test/h/server/workspace/workspace' });
  const keys = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'MutationObserver'] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const hidden = Boolean(this.closest('[hidden]'));
    return { x: 100, y: 500, left: 100, top: 500, right: 700, bottom: 600, width: hidden ? 0 : 600, height: hidden ? 0 : 100, toJSON() { return {}; } };
  };
  const overlay = createOverlayController(new Map([['server', {
    translate: async () => { throw new Error('Unexpected translation'); },
    agentModel: async () => null,
    englishLockModels: async () => [],
    subscribeAgentModels: () => () => {},
  }]]));
  try { overlay.refresh(); await run(dom.window.document, overlay); }
  finally {
    overlay.dispose();
    dom.window.close();
    keys.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test('file editor and empty workspace do not show draft translation controls', async () => {
  for (const html of [fileEditor, '<div>File preview</div>']) {
    await withOverlay(html, async document => { assert.equal(document.querySelectorAll(controls).length, 0); });
  }
});

test('chat composer shows controls and removing it clears them without an input event', async () => {
  await withOverlay(composer, async document => {
    assert.equal(document.querySelectorAll(controls).length, 2);
    document.querySelector('[data-testid="message-input-root"]')!.remove();
    document.body.insertAdjacentHTML('afterbegin', fileEditor);
    await settle();
    assert.equal(document.querySelectorAll(controls).length, 0);
    document.body.insertAdjacentHTML('afterbegin', composer);
    await settle();
    assert.equal(document.querySelectorAll(controls).length, 2);
  });
});

test('hidden chat cannot cause controls to attach to the file editor', async () => {
  await withOverlay(composer + fileEditor, async document => {
    const root = document.querySelector<HTMLElement>('[data-testid="message-input-root"]')!;
    root.hidden = true;
    await settle();
    assert.equal(document.querySelectorAll(controls).length, 0);
    root.hidden = false;
    await settle();
    assert.equal(document.querySelectorAll(controls).length, 2);
  });
});
