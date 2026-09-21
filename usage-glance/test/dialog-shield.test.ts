import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, act as domAct, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { JSDOM } from 'jsdom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { portalRoot, useDialogTooltipShield } from '../client/dialog-shield.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Listener = (event: { stopPropagation(): void }) => void;
class FakeElement {
  id = '';
  parentElement: FakeElement | null = null;
  listeners = new Map<string, Listener[]>();
  constructor(parent?: FakeElement, container = false) {
    if (parent) this.parentElement = parent;
    if (container) this.id = 'overlay-root';
  }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type: string, listener: Listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)); }
}

function Dialog() {
  const ref = useDialogTooltipShield();
  return createElement('view', { ref });
}

test('shields the element directly below the portal container from React enter/leave events', () => {
  const body = new FakeElement();
  const overlayRoot = new FakeElement(body, true);
  const modal = new FakeElement(overlayRoot);
  const content = new FakeElement(new FakeElement(modal));
  assert.equal(portalRoot(content), modal);
  let tree!: ReactTestRenderer;
  act(() => { tree = create(createElement(Dialog), { createNodeMock: () => content }); });
  const types = ['pointerover', 'pointerout', 'mouseover', 'mouseout'];
  for (const type of types) assert.equal(modal.listeners.get(type)?.length, 1, `${type} listener on the modal root`);
  assert.equal(content.listeners.size, 0);
  let stopped = 0;
  modal.listeners.get('mouseover')![0]({ stopPropagation: () => { stopped++; } });
  assert.equal(stopped, 1);
  act(() => tree.unmount());
  for (const type of types) assert.equal(modal.listeners.get(type)?.length, 0, `${type} listener removed on unmount`);
});

test('does nothing without a DOM node or a Paseo overlay ancestor', () => {
  assert.equal(portalRoot(new FakeElement(new FakeElement())), null);
  let tree!: ReactTestRenderer;
  act(() => { tree = create(createElement(Dialog), { createNodeMock: () => null }); });
  act(() => tree.unmount());
  const detached = new FakeElement();
  act(() => { tree = create(createElement(Dialog), { createNodeMock: () => detached }); });
  assert.equal(detached.listeners.size, 0);
  act(() => tree.unmount());
});

test('real portal hover cannot leave the header tooltip open after dismissal', () => {
  const dom = new JSDOM('<div id="app"></div><div id="overlay-root"></div>');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const document = dom.window.document;
  const container = document.getElementById('app')!;
  const overlay = document.getElementById('overlay-root')!;
  const root = createRoot(container);
  function Content() {
    const ref = useDialogTooltipShield();
    return createElement('div', { ref, id: 'content' }, 'Quota details');
  }
  function Header({ dialog }: { dialog: boolean }) {
    const [open, setOpen] = useState(false);
    return createElement('div', null,
      createElement('div', {
        id: 'trigger',
        onPointerEnter: () => setOpen(true), onPointerLeave: () => setOpen(false),
        onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false),
      }, 'Quota', dialog ? createPortal(createElement('div', { id: 'modal' }, createElement(Content)), overlay) : null),
      open ? createElement('span', { id: 'tooltip' }, 'Pinned quota') : null,
    );
  }
  const dispatch = (node: Element, type: string) => domAct(() => {
    node.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true }));
  });
  try {
    for (const type of ['pointerover', 'mouseover']) {
      domAct(() => root.render(createElement(Header, { dialog: true })));
      // React portals are event containers but do not carry __reactContainer$.
      assert.equal(Object.keys(overlay).some(key => key.startsWith('__reactContainer$')), false);
      dispatch(document.getElementById('content')!, type);
      domAct(() => root.render(createElement(Header, { dialog: false })));
      assert.equal(document.getElementById('tooltip') === null, true, `${type}: tooltip stays closed after dialog unmount`);
      // The dialog shield must not disable ordinary header tooltips.
      dispatch(document.getElementById('trigger')!, type);
      assert.ok(document.getElementById('tooltip'));
      dispatch(document.getElementById('trigger')!, type.replace('over', 'out'));
      assert.equal(document.getElementById('tooltip') === null, true);
    }
  } finally {
    domAct(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of [['window', previousWindow], ['document', previousDocument]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
