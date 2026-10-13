import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { installComposerPopupGuard } from '../client/composer-popup-guard';

test('popup guard is independent of legacy controllers and remains until every host disconnects', () => {
  const dom = new JSDOM('<button data-paseo-translate="launcher" style="visibility:visible">译</button>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  try {
    const stopA = installComposerPopupGuard(), stopB = installComposerPopupGuard();
    assert.equal(dom.window.document.head.querySelectorAll('style').length, 1);
    const button = dom.window.document.querySelector('button');
    stopA(); stopA();
    assert.equal(dom.window.document.head.querySelectorAll('style').length, 1);
    const stopReloadedA = installComposerPopupGuard();
    stopB();
    assert.equal(dom.window.document.head.querySelectorAll('style').length, 1);
    assert.equal(dom.window.document.querySelector('button'), button);
    stopReloadedA();
    assert.equal(dom.window.document.head.querySelectorAll('style').length, 0);
    assert.equal(dom.window.document.querySelector('button'), button);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
    dom.window.close();
  }
});
