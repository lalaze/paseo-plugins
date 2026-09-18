import type { PaseoApi } from "@getpaseo/client";

export type LaunchWorkspace = { id: string; name: string; directory: string };

export async function listLaunchWorkspaces(workspaces: Pick<PaseoApi["workspaces"], "list">): Promise<LaunchWorkspace[]> {
  const entries = new Map<string, LaunchWorkspace>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
    for (const workspace of page.entries) {
      // A worktree's directory can differ from the project's root. Never use
      // projectRootPath as a fallback, or the task could switch another checkout.
      if (workspace.projectKind !== "git" || workspace.archivingAt || !workspace.workspaceDirectory?.trim()) continue;
      entries.set(workspace.id, { id: workspace.id, name: workspace.name, directory: workspace.workspaceDirectory });
    }
    cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    if (page.pageInfo.hasMore && (!cursor || cursors.has(cursor))) throw new Error("The workspace list was incomplete. Refresh and try again.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...entries.values()];
}
