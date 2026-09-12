import type { PaseoApi, PaseoWorkspaceUpdate } from '@getpaseo/client';

/** Headers follow workspaces, including those containing only terminals or files. */
export function followWorkspaces(paseo: PaseoApi, changed: (ids: Set<string>) => void, intervalMs = 60000) {
  let stopped = false;
  let loading = false;
  let pending: PaseoWorkspaceUpdate[] = [];
  let ids = new Set<string>();
  function apply(update: PaseoWorkspaceUpdate) {
    if (update.kind === 'remove') ids.delete(update.id);
    else if (update.workspace.archivingAt) ids.delete(update.workspace.id);
    else ids.add(update.workspace.id);
  }
  const unsubscribe = paseo.workspaces.subscribe(update => {
    if (stopped) return;
    if (loading) pending.push(update);
    apply(update);
    changed(ids);
  });
  async function sync() {
    if (loading || stopped) return;
    loading = true;
    pending = [];
    try {
      const snapshot = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        if (stopped) return;
        for (const workspace of page.entries) {
          if (!workspace.archivingAt) snapshot.add(workspace.id);
        }
        const next = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
        if (page.pageInfo.hasMore && (!next || next === cursor)) throw new Error('Invalid workspace pagination');
        cursor = next;
      } while (cursor);
      ids = snapshot;
      for (const update of pending) apply(update);
      changed(ids);
    } catch {
      // Preserve current headers during disconnects and retry on the next tick.
    } finally {
      loading = false;
      pending = [];
    }
  }
  const timer = setInterval(() => { void sync(); }, intervalMs);
  void sync();
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    ids.clear();
    pending = [];
  };
}
