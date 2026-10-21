import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createOverlayController } from '../client/selection';

const controls = '[data-paseo-translate="launcher"], [data-paseo-translate="english-guard"], [data-paseo-translate="word-toggle"]';
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
    assert.equal(document.querySelectorAll(controls).length, 3);
    document.querySelector('[data-testid="message-input-root"]')!.remove();
    document.body.insertAdjacentHTML('afterbegin', fileEditor);
    await settle();
    assert.equal(document.querySelectorAll(controls).length, 0);
    document.body.insertAdjacentHTML('afterbegin', composer);
    await settle();
    assert.equal(document.querySelectorAll(controls).length, 3);
  });
});

test('composer controls reserve a row below collaboration cards and move with a replacement composer', async () => {
  await withOverlay('<div id="collaboration">方案 执行 审查 验收</div>' + composer, async document => {
    const root = document.querySelector('[data-testid="message-input-root"]')!;
    const toolbar = document.querySelector<HTMLElement>('[data-paseo-translate="composer-toolbar"]')!;
    assert.ok(toolbar, 'controls need their own row instead of floating over the collaboration card');
    assert.equal(root.firstElementChild, toolbar);
    assert.equal(toolbar.style.display, 'flex');
    assert.equal(toolbar.style.flexShrink, '0');
    for (const control of document.querySelectorAll<HTMLElement>(controls)) {
      assert.equal(control.parentElement, toolbar);
      assert.equal(control.style.position, '');
    }
    root.remove();
    document.body.insertAdjacentHTML('beforeend', composer);
    await settle();
    assert.equal(document.querySelectorAll('[data-paseo-translate="composer-toolbar"]').length, 1);
    assert.equal(document.querySelector('[data-testid="message-input-root"]')!.firstElementChild, toolbar);
    document.querySelector('[data-testid="message-input-root"]')!.remove();
    await settle();
    assert.equal(document.querySelector('[data-paseo-translate="composer-toolbar"]'), null);
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
    assert.equal(document.querySelectorAll(controls).length, 3);
  });
});

test('legacy composer inputs keep the toolbar outside the editable element', async () => {
  await withOverlay('<div id="legacy"><textarea data-testid="agent-composer-input" placeholder="Message"></textarea></div>', async document => {
    const toolbar = document.querySelector('[data-paseo-translate="composer-toolbar"]')!;
    assert.equal(toolbar.parentElement?.id, 'legacy');
    assert.equal(toolbar.nextElementSibling, document.querySelector('textarea'));
    assert.equal(document.querySelectorAll(controls).length, 3);
  });
});

test('word switch persists independently of API settings and keeps the existing text selection', async () => {
  await withOverlay(composer + '<p id="copy">copy this text</p>', async (document, overlay) => {
    const selector = '[data-paseo-translate="word-toggle"]';
    const toggle = document.querySelector<HTMLButtonElement>(selector)!;
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    const selection = document.defaultView!.getSelection()!;
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#copy')!); selection.addRange(range);
    const pointerdown = new document.defaultView!.MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    toggle.dispatchEvent(pointerdown); assert.equal(pointerdown.defaultPrevented, true);
    toggle.click();
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(selection.toString(), 'copy this text');
    document.querySelector('[data-testid="message-input-root"]')!.remove();
    overlay.refresh();
    document.body.insertAdjacentHTML('afterbegin', composer); overlay.refresh();
    assert.equal(document.querySelector(selector)!.getAttribute('aria-pressed'), 'false');
  });
});

test('context-window hover card, menus and tooltips hide all composer controls and restore them on close', async () => {
  await withOverlay(composer, async document => {
    const visibility = () => Array.from(document.querySelectorAll<HTMLElement>(controls)).map(node => node.style.visibility);
    assert.deepEqual(visibility(), ['visible', 'visible', 'visible']);
    for (const role of ['dialog', 'alertdialog', 'menu', 'listbox', 'tooltip']) {
      const popup = document.createElement('div');
      popup.setAttribute('role', role);
      if (role === 'dialog') popup.dataset.testid = 'context-window-details';
      // The real context-window hover card does not set aria-modal.
      popup.textContent = 'Context window'; document.body.append(popup); await settle();
      assert.deepEqual(visibility(), ['hidden', 'hidden', 'hidden'], role);
      popup.remove(); await settle();
      assert.deepEqual(visibility(), ['visible', 'visible', 'visible'], role);
    }
  });
});

test('hidden or closing host popups do not hide controls; reopening and ancestor visibility changes are observed', async () => {
  await withOverlay(composer + '<div id="portal" hidden><div role="dialog" data-state="open">Context window</div></div>', async document => {
    const portal = document.querySelector<HTMLElement>('#portal')!;
    const popup = portal.firstElementChild!;
    const visibility = () => document.querySelector<HTMLElement>(controls)!.style.visibility;
    assert.equal(visibility(), 'visible');
    portal.hidden = false; await settle(); assert.equal(visibility(), 'hidden');
    popup.setAttribute('data-state', 'closed'); await settle(); assert.equal(visibility(), 'visible');
    popup.setAttribute('data-state', 'open'); await settle(); assert.equal(visibility(), 'hidden');
    portal.style.display = 'none'; await settle(); assert.equal(visibility(), 'visible');
    portal.style.display = ''; await settle(); assert.equal(visibility(), 'hidden');
    popup.setAttribute('aria-hidden', 'true'); await settle(); assert.equal(visibility(), 'visible');
    popup.removeAttribute('aria-hidden'); await settle(); assert.equal(visibility(), 'hidden');
  });
});

test('the plugin word bubble does not hide its own composer controls', async () => {
  await withOverlay(composer, async document => {
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" data-paseo-translate="word">Translation</div>');
    await settle();
    assert.deepEqual(Array.from(document.querySelectorAll<HTMLElement>(controls)).map(node => node.style.visibility), ['visible', 'visible', 'visible']);
  });
});

test('modal dialogs beside the sidebar composer leave its controls usable', async () => {
  await withOverlay(composer + '<div role="dialog" aria-modal="true" data-testid="new-agent-dialog">New task</div>', async document => {
    await settle();
    assert.deepEqual(Array.from(document.querySelectorAll<HTMLElement>(controls)).map(node => node.style.visibility), ['visible', 'visible', 'visible']);
  });
});
