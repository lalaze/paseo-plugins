import type { PaseoApi } from '@getpaseo/client';
import { posix, win32 } from 'node:path';
import { enabledConsumptionSources, type SourceId, type WorkspaceIdentity } from '../shared/consumption';

export function normalizeDirectory(value: string): string {
  const windows = /^[a-z]:[/\\]|^\\\\/i.test(value);
  if (!windows && !value.startsWith('/')) return '';
  const normalized = (windows ? win32.normalize(value).replaceAll('\\', '/').toLowerCase() : posix.normalize(value)).replace(/\/$/, '');
  return normalized || '/';
}

export type WorkspaceBinding = { source: SourceId; sessionId: string; workspaceId?: string; cwd: string };
export function workspaceResolver(workspaces: WorkspaceIdentity[], bindings: WorkspaceBinding[] = []) {
  const directories = workspaces.map(workspace => ({ workspace, path: normalizeDirectory(workspace.directory) })).filter(value => value.path);
  function directory(cwd?: string): WorkspaceIdentity | undefined {
    const path = cwd ? normalizeDirectory(cwd) : '';
    if (!path) return;
    const matches = directories.filter(item => path === item.path || path.startsWith(item.path === '/' ? '/' : `${item.path}/`)).sort((a, b) => b.path.length - a.path.length);
    // Equal paths are ambiguous. A session binding can disambiguate them.
    return matches.length && matches[0].path !== matches[1]?.path ? matches[0].workspace : undefined;
  }
  function session(source: SourceId, sessionId?: string, cwd?: string): WorkspaceIdentity | undefined {
    const matches = sessionId ? bindings.filter(item => item.source === source && item.sessionId === sessionId) : [];
    const ids = new Set(matches.map(item => item.workspaceId ?? directory(item.cwd)?.id));
    if (ids.size === 1) {
      const workspace = workspaces.find(item => item.id === [...ids][0]);
      if (workspace) return workspace;
    }
    return matches.length ? undefined : directory(cwd);
  }
  function claudeProject(project: string): WorkspaceIdentity | undefined {
    const matches = workspaces.filter(item => item.directory.replace(/[^a-zA-Z0-9]/g, '-') === project);
    return matches.length === 1 ? matches[0] : undefined;
  }
  return { directory, session, claudeProject };
}
export type WorkspaceResolver = ReturnType<typeof workspaceResolver>;

/** Read the same workspace titles/directories shown in the sidebar, including Done. */
export async function readWorkspaceCatalog(paseo: PaseoApi): Promise<WorkspaceResolver> {
  const workspaces: WorkspaceIdentity[] = [], bindings: WorkspaceBinding[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const item of page.entries) if (!item.archivingAt && item.workspaceDirectory) workspaces.push({ id: item.id, label: item.title?.trim() || item.name, directory: item.workspaceDirectory });
    const next = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    if (page.pageInfo.hasMore && (!next || seen.has(next))) throw new Error('本机 Workspace 列表不完整，请重试');
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  // Session links cover providers whose native usage does not include cwd.
  // If the list is unavailable, explicit native directories remain usable.
  try {
    seen.clear();
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const { agent } of page.entries) {
        const source = enabledConsumptionSources([{ provider: agent.provider, enabled: true }])[0];
        if (source && agent.persistence?.sessionId) bindings.push({ source, sessionId: agent.persistence.sessionId, workspaceId: agent.workspaceId, cwd: agent.cwd });
      }
      const next = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
      if (page.pageInfo.hasMore && (!next || seen.has(next))) throw new Error('Incomplete agents');
      if (next) seen.add(next);
      cursor = next;
    } while (cursor);
  } catch { bindings.length = 0; }
  return workspaceResolver(workspaces, bindings);
}
