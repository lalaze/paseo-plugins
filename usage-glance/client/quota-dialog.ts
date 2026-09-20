import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

type Session = { presenter: object; workspaceId: string };
type Registry = { close?: () => void };
function getRegistry(): Registry {
  const key = Symbol.for('lalaze.paseo-usage-glance.quota-dialog.v1');
  const shared = globalThis as typeof globalThis & { [key]?: Registry };
  return shared[key] ??= {};
}

/** Button clicks own visibility. Retained copies of a header only elect one
 * presenter; mounting content never opens or closes another copy's menu. */
export function createQuotaDialogController() {
  const registry = getRegistry();
  const presenters = new Map<object, string>();
  const listeners = new Set<() => void>();
  let workspaceId: string | null = null, snapshot: Session | null = null, disposed = false;
  function publish() {
    const presenter = [...presenters].find(([, id]) => id === workspaceId)?.[0];
    if (presenter === snapshot?.presenter && workspaceId === snapshot?.workspaceId) return;
    const next = presenter && workspaceId !== null ? { presenter, workspaceId } : null;
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }
  function close() {
    workspaceId = null;
    if (registry.close === close) registry.close = undefined;
    publish();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    register(presenter: object, id: string) {
      if (disposed) return () => {};
      presenters.set(presenter, id);
      publish();
      return () => { presenters.delete(presenter); publish(); };
    },
    toggle(id: string) {
      if (disposed) return;
      if (workspaceId === id) { close(); return; }
      registry.close?.();
      registry.close = close;
      workspaceId = id;
      publish();
    },
    dismiss(session: Session | null) {
      // An exiting/replaced native modal may deliver its dismissal late.
      if (session && session === snapshot) close();
    },
    dispose() { disposed = true; close(); presenters.clear(); },
  };
}

export function useQuotaDialog(controller: ReturnType<typeof createQuotaDialogController>, workspaceId: string) {
  const presenter = useRef({}).current;
  const session = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => controller.register(presenter, workspaceId), [controller, presenter, workspaceId]);
  const open = session?.presenter === presenter;
  return { open, onOpenChange: (next: boolean) => { if (!next && open) controller.dismiss(session); } };
}
