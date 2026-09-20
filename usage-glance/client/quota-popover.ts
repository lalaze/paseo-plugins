type Popup = { close(): void };
type Registry = { active?: Popup };

// Each connected host evaluates its own plugin bundle. Share ownership across
// those bundles, since retained workspaces can leave their portals open.
function getRegistry(): Registry {
  const key = Symbol.for('lalaze.paseo-usage-glance.quota-popover.v1');
  const shared = globalThis as typeof globalThis & { [key]?: Registry };
  return shared[key] ??= {};
}

export function createQuotaPopoverScope() {
  const registry = getRegistry();
  const owned = new Set<Popup>();
  let disposed = false;
  return {
    open(close: () => void) {
      if (disposed) { close(); return () => {}; }
      const popup: Popup = { close: () => { release(); close(); } };
      function release() {
        owned.delete(popup);
        if (registry.active === popup) registry.active = undefined;
      }
      const previous = registry.active;
      owned.add(popup);
      // Publish first: delayed cleanup from the old portal must not clear this.
      registry.active = popup;
      previous?.close();
      // React cleanup only releases ownership; calling close here would also
      // close a still-open menu during StrictMode's effect cleanup/replay.
      return release;
    },
    dispose() {
      disposed = true;
      for (const popup of owned) popup.close();
    },
  };
}
