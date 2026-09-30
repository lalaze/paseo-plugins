import type { PluginClientContext, PluginHostSummary } from '@getpaseo/plugin/client';

type Rpc = PluginClientContext['rpc'];

export interface HostIdentity {
  id: string;
  label: string;
}

export interface TodoHost extends HostIdentity {
  rpc: Rpc;
}

/**
 * Paseo loads this client bundle once per connected host, each with an `rpc` bound to that host. Every copy
 * registers here, on a registry shared through `globalThis`, so any host's Tasks page can read and act on all of
 * them. Only already-authorised plugin RPCs are shared; no addresses or credentials are.
 */
export function createHostRegistry() {
  const entries = new Map<symbol, { identity: HostIdentity | null; rpc: Rpc; order: number }>();
  const listeners = new Set<() => void>();
  let snapshot: readonly TodoHost[] = [];
  let order = 0;

  function publish() {
    // Latest registration per server id wins: a reconnect replaces the copy it came back as.
    const byId = new Map<string, { host: TodoHost; order: number }>();
    for (const entry of entries.values()) {
      if (!entry.identity) continue;
      const current = byId.get(entry.identity.id);
      if (!current || current.order < entry.order) byId.set(entry.identity.id, { host: { ...entry.identity, rpc: entry.rpc }, order: entry.order });
    }
    const next = [...byId.values()].map(item => item.host).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const same = next.length === snapshot.length && next.every((host, index) => {
      const previous = snapshot[index];
      return previous && previous.id === host.id && previous.label === host.label && previous.rpc === host.rpc;
    });
    if (same) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    register(rpc: Rpc) {
      const key = Symbol('paseo-todo host');
      entries.set(key, { identity: null, rpc, order: order += 1 });
      return {
        rpc,
        identify(identity: HostIdentity) {
          const entry = entries.get(key);
          if (!entry) return;
          entry.identity = identity;
          publish();
        },
        dispose() {
          if (entries.delete(key)) publish();
        },
      };
    },
  };
}

export type HostRegistry = ReturnType<typeof createHostRegistry>;

/** One registry per Paseo client, shared by every host's copy of this bundle. Bump the key if its shape changes. */
export function sharedHostRegistry(): HostRegistry {
  const key = Symbol.for('lalaze.paseo-todo.host-registry.v1');
  const shared = globalThis as typeof globalThis & { [key]?: HostRegistry };
  return shared[key] ??= createHostRegistry();
}

/** The name the app shows for this host, else the machine name the host reported. */
export function hostLabel(host: HostIdentity, appHosts: readonly Pick<PluginHostSummary, 'serverId' | 'label'>[]): string {
  return appHosts.find(item => item.serverId === host.id)?.label || host.label;
}
