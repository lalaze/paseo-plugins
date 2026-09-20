import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createQuotaDialogController, useQuotaDialog } from '../client/quota-dialog.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Controller = ReturnType<typeof createQuotaDialogController>;
function Presenter({ controller, workspace }: { controller: Controller; workspace: string }) {
  const { open, onOpenChange } = useQuotaDialog(controller, workspace);
  return createElement('dialog', { open, onOpenChange });
}
const visible = (tree: ReactTestRenderer) => tree.root.findAllByType('dialog').filter(node => node.props.open);
const presenters = (controller: Controller, workspaces: string[]) => createElement(StrictMode, {},
  ...workspaces.map((workspace, i) => createElement(Presenter, { key: i, controller, workspace })));

test('duplicate retained headers: every click opens one dialog, dismissal and reopen keep working', () => {
  const controller = createQuotaDialogController();
  let tree!: ReactTestRenderer;
  act(() => { tree = create(presenters(controller, ['a', 'a', 'b'])); });
  try {
    for (let i = 0; i < 10; i++) {
      act(() => controller.toggle('a'));
      assert.equal(visible(tree).length, 1);
      act(() => tree.update(presenters(controller, ['a', 'a', 'b'])));
      assert.equal(visible(tree).length, 1, 'rerender must not close the open dialog');
      act(() => visible(tree)[0].props.onOpenChange(false));
      assert.equal(visible(tree).length, 0);
    }
    act(() => controller.toggle('a'));
    act(() => controller.toggle('a'));
    assert.equal(visible(tree).length, 0, 'second click toggles closed');
  } finally { act(() => { controller.dispose(); tree.unmount(); }); }
});

test('workspace/host switches and stale dismissals preserve the newest dialog', () => {
  const first = createQuotaDialogController(), second = createQuotaDialogController();
  let tree!: ReactTestRenderer;
  act(() => { tree = create(createElement(StrictMode, {}, presenters(first, ['a', 'a', 'b']), presenters(second, ['a', 'a']))); });
  try {
    act(() => first.toggle('a'));
    const oldDismiss = visible(tree)[0].props.onOpenChange;
    act(() => first.toggle('b'));
    assert.equal(visible(tree).length, 1);
    act(() => oldDismiss(false));
    assert.equal(visible(tree).length, 1);
    act(() => second.toggle('a'));
    assert.equal(visible(tree).length, 1);
    act(() => first.dispose());
    assert.equal(visible(tree).length, 1);
    act(() => second.dispose());
    assert.equal(visible(tree).length, 0);
  } finally { act(() => { first.dispose(); second.dispose(); tree.unmount(); }); }
});

test('removing the elected header transfers presentation without duplicate dialogs', () => {
  const controller = createQuotaDialogController();
  let tree!: ReactTestRenderer;
  const view = (first: boolean) => createElement(StrictMode, {},
    first ? createElement(Presenter, { key: 'first', controller, workspace: 'a' }) : null,
    createElement(Presenter, { key: 'second', controller, workspace: 'a' }));
  act(() => { tree = create(view(true)); controller.toggle('a'); });
  try {
    assert.equal(visible(tree).length, 1);
    const oldDismiss = visible(tree)[0].props.onOpenChange;
    act(() => tree.update(view(false)));
    assert.equal(visible(tree).length, 1);
    act(() => oldDismiss(false));
    assert.equal(visible(tree).length, 1);
  } finally { act(() => { controller.dispose(); tree.unmount(); }); }
});

test('host pending spinner can temporarily unmount every icon without losing the click', () => {
  const controller = createQuotaDialogController();
  let tree!: ReactTestRenderer;
  act(() => { tree = create(presenters(controller, ['a', 'a'])); });
  try {
    act(() => tree.update(presenters(controller, [])));
    act(() => controller.toggle('a'));
    act(() => tree.update(presenters(controller, ['a', 'a'])));
    assert.equal(visible(tree).length, 1);
    const previousDismiss = visible(tree)[0].props.onOpenChange;
    act(() => previousDismiss(false));
    act(() => controller.toggle('a'));
    act(() => previousDismiss(false));
    assert.equal(visible(tree).length, 1, 'previous session cannot dismiss a reopened dialog');
    act(() => controller.dispose());
    act(() => controller.toggle('a'));
    assert.equal(visible(tree).length, 0);
  } finally { act(() => { controller.dispose(); tree.unmount(); }); }
});
