import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { portalRoot, useDialogTooltipShield } from '../client/dialog-shield.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Listener = (event: { stopPropagation(): void }) => void;
class FakeElement {
  parentElement: FakeElement | null = null;
  listeners = new Map<string, Listener[]>();
  constructor(parent?: FakeElement, container = false) {
    if (parent) this.parentElement = parent;
    if (container) Object.assign(this, { __reactContainer$abc: {} });
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

test('does nothing without a DOM node or a React container ancestor', () => {
  assert.equal(portalRoot(new FakeElement(new FakeElement())), null);
  let tree!: ReactTestRenderer;
  act(() => { tree = create(createElement(Dialog), { createNodeMock: () => null }); });
  act(() => tree.unmount());
  const detached = new FakeElement();
  act(() => { tree = create(createElement(Dialog), { createNodeMock: () => detached }); });
  assert.equal(detached.listeners.size, 0);
  act(() => tree.unmount());
});
