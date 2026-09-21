import { useLayoutEffect, useRef } from 'react';
import type { View } from 'react-native';

type Listener = (event: { stopPropagation(): void }) => void;
type DomNode = {
  parentElement: DomNode | null;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
};

/** React derives synthetic enter/leave from these bubbling events at the portal container. */
const shieldedEvents = ['pointerover', 'pointerout', 'mouseover', 'mouseout'];

const isDomNode = (value: unknown): value is DomNode =>
  typeof value === 'object' && value !== null && 'parentElement' in value && typeof (value as DomNode).addEventListener === 'function';

const isReactContainer = (node: DomNode) => Object.keys(node).some(key => key.startsWith('__reactContainer$'));

/** The highest element below the React portal container that hosts this subtree. */
export function portalRoot(node: DomNode): DomNode | null {
  let root: DomNode = node;
  while (root.parentElement && !isReactContainer(root.parentElement)) root = root.parentElement;
  return root.parentElement ? root : null;
}

/** Paseo wraps header buttons in a tooltip that opens on React pointer-enter
 * events. Portal children still count as the button's descendants, so a
 * dialog mounted from the header icon would open the tooltip over itself and,
 * unmounting without a leave event, leave it stuck open. Keep the dialog's
 * DOM events from reaching that trigger. */
export function useDialogTooltipShield() {
  const ref = useRef<View>(null);
  useLayoutEffect(() => {
    const node: unknown = ref.current;
    const root = isDomNode(node) ? portalRoot(node) : null;
    if (!root) return;
    const stop: Listener = event => event.stopPropagation();
    for (const type of shieldedEvents) root.addEventListener(type, stop);
    return () => { for (const type of shieldedEvents) root.removeEventListener(type, stop); };
  }, []);
  return ref;
}
