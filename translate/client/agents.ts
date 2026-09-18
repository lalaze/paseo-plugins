import type { PaseoAgentUpdate, PaseoApi } from '@getpaseo/client';

type AgentLike = { id: string; workspaceId?: string; archivedAt?: string | null };
type AgentsApi = Pick<PaseoApi['agents'], 'list' | 'subscribe'>;

function placement(agent: AgentLike) {
  return agent.workspaceId && !agent.archivedAt ? agent.workspaceId : null;
}

/** Tracks active agents as id → workspaceId, the way Usage Glance follows workspaces. */
export function followAgents(agents: AgentsApi, changed: (agents: ReadonlyMap<string, string>) => void, intervalMs = 60000) {
  let stopped = false;
  let loading = false;
  let pending: PaseoAgentUpdate[] = [];
  let known = new Map<string, string>();
  function apply(update: PaseoAgentUpdate) {
    if (update.kind === 'remove') { known.delete(update.agentId); return; }
    const workspaceId = placement(update.agent);
    if (workspaceId) known.set(update.agent.id, workspaceId);
    else known.delete(update.agent.id);
  }
  const unsubscribe = agents.subscribe(update => {
    if (stopped) return;
    if (loading) pending.push(update);
    apply(update);
    changed(known);
  });
  async function sync() {
    if (loading || stopped) return;
    loading = true;
    pending = [];
    try {
      const snapshot = new Map<string, string>();
      let cursor: string | undefined;
      do {
        const page = await agents.list({ scope: 'active', page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        if (stopped) return;
        for (const entry of page.entries) {
          const workspaceId = placement(entry.agent);
          if (workspaceId) snapshot.set(entry.agent.id, workspaceId);
        }
        const next = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
        if (page.pageInfo.hasMore && (!next || next === cursor)) throw new Error('Invalid agent pagination');
        cursor = next;
      } while (cursor);
      known = snapshot;
      for (const update of pending) apply(update);
      changed(known);
    } catch {
      // Keep the current pills during disconnects and retry on the next tick.
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
    known.clear();
    pending = [];
  };
}
