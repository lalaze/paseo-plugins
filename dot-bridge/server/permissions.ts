import { dotBridgeError } from '../shared/errors';
import { canonicalJson } from '../shared/mcp';
import { mutationPermissionTools as mutations, attachmentReadPermissionTools as attachments, permissionCurrent, samePermissionTool, type DotPermission, type PermissionIntent, type PermissionOperation } from '../shared/permissions';
import type { Task } from '../shared/schema';
import { validateLocalPath } from './local-files';
import { attachmentIdSchema, MAX_ATTACHMENT_BYTES } from '../shared/attachments';
import { automaticPermissionTools } from '../shared/workspace-authorization';

export function validatePermissionIntent(p: PermissionIntent): void {
  const { toolName, targets, operation } = p.scope;
  if (new Set(targets).size !== targets.length) throw dotBridgeError('task-rejected', 'Duplicate permission targets');
  if (toolName === 'run_dot_command') {
    if (operation?.kind !== 'command' || targets.length !== 1 || targets[0] !== (operation.cwd || '/')) throw dotBridgeError('permission-required', 'Command approval must bind operationId, executable, args, cwd and timeout');
    try { validateLocalPath(operation.cwd ?? '', true); }
    catch { throw dotBridgeError('task-rejected', 'Command cwd must be a normalized relative workspace directory. Use cwd="" and targets=["/"] for the workspace root; do not send an absolute workspace path.'); }
  } else if (toolName === 'apply_dot_changes') {
    if (operation?.kind !== 'files') throw dotBridgeError('permission-required', 'File approval requires operationId and exact before/after SHA-256 for each change');
    if (operation.changes.length !== targets.length || new Set(operation.changes.map(c => c.path)).size !== targets.length
      || operation.changes.some(c => !targets.includes(c.path) || (c.expectedSha256 === null && c.contentSha256 === null))) throw dotBridgeError('permission-required', 'Operation must match the exact targets');
    operation.changes.forEach(c => validateLocalPath(c.path));
  } else if (mutations.has(toolName)) {
    if (operation?.kind !== 'attachment' || targets.length !== 1 || targets[0] !== operation.name) throw dotBridgeError('permission-required', 'Upload approval requires operationId, name, mediaType, size and SHA-256');
    if ((toolName === 'upload_dot_attachment' && operation.size > MAX_ATTACHMENT_BYTES) || (toolName === 'upload_dot_attachment_chunk' && operation.size === 0)) throw dotBridgeError('attachment-invalid', 'Choose an upload tool that supports this size');
  } else {
    if (operation) throw dotBridgeError('permission-required', 'Operation binding is only supported for Bridge mutations');
    if (toolName === 'read_dot_workspace_changes' && (targets.length !== 1 || targets[0] !== '/')) throw dotBridgeError('permission-required', 'Workspace review uses the exact workspace root target /');
    if (toolName === 'read_dot_file' || toolName === 'list_dot_files') targets.forEach(path => validateLocalPath(path === '/' && toolName === 'list_dot_files' ? '' : path, toolName === 'list_dot_files'));
    if (attachments.has(toolName)) targets.forEach(id => attachmentIdSchema.parse(id));
  }
}

/** Once access has needed confirmation, ordinary messages never silently restore that access.
 * Keep this guard across rounds, including denied/expired/consumed requests. Only the local UI
 * or an explicit host workspace policy can grant access. Attachment read aliases share the same guard.
 */
export function assertPermissionAccess(task: Task, toolName: string, targets: string[], operation?: PermissionOperation, automaticGrantId?: string): DotPermission | undefined {
  const mutation = mutations.has(toolName);
  const current = task.permissions.filter(p => permissionCurrent(task, p));
  if (mutation && current.some(p => p.status === 'pending' || p.status === 'denied' || p.platformBlock)) throw dotBridgeError('permission-required');
  if (automaticGrantId && automaticPermissionTools.has(toolName)) {
    const latestTool = task.permissions.filter(p => samePermissionTool(p.scope.toolName, toolName)).at(-1);
    // A host opt-in is not permission to repeat a denied or platform-blocked action.
    if (latestTool?.status === 'denied' || latestTool?.platformBlock || latestTool?.status === 'pending') throw dotBridgeError('permission-required', 'Resolve the explicit decision or platform block first');
    if (!latestTool || latestTool.workspaceGrantId || !permissionCurrent(task, latestTool) || latestTool.status !== 'approved') {
      // Return an exact current automatic approval for consumption; otherwise the live policy grants access.
      return latestTool?.workspaceGrantId === automaticGrantId && permissionCurrent(task, latestTool)
        && (!operation || canonicalJson(latestTool.scope.operation) === canonicalJson(operation)) ? latestTool : undefined;
    }
    // A current explicit scoped approval remains narrower than the automatic workspace policy.
    if (targets.some(target => !latestTool.scope.targets.includes(target))
      || (mutation && canonicalJson(operation) !== canonicalJson(latestTool.scope.operation))) throw dotBridgeError('permission-required');
    return latestTool;
  }
  // Any scoped confirmation ends default mutation access. A read/external grant cannot
  // authorize writes, and its expiry must not restore that access after an ordinary message.
  const relevant = mutation ? task.permissions : task.permissions.filter(p => samePermissionTool(p.scope.toolName, toolName));
  if (!relevant.length) {
    if (toolName === 'run_dot_command') throw dotBridgeError('permission-required', 'Every command needs an explicit operation-bound approval');
    return;
  }
  const latest = relevant.at(-1)!;
  if (!permissionCurrent(task, latest) || latest.status !== 'approved' || latest.platformBlock
    || latest.workspaceGrantId !== undefined
    || (mutation ? latest.scope.toolName !== toolName : !samePermissionTool(latest.scope.toolName, toolName))
    || targets.some(target => !latest.scope.targets.includes(target))
    || (mutation && (!operation || !latest.scope.operation || canonicalJson(operation) !== canonicalJson(latest.scope.operation)))) {
    throw dotBridgeError('permission-required', 'Explicit current approval is required for this exact operation; a follow-up message does not renew permission');
  }
  return latest;
}

export function consumePermission(task: Task, permission: DotPermission | undefined, at: number): void {
  if (!permission) return;
  task.permissions = task.permissions.map(p => p.requestId === permission.requestId ? { ...p, consumedAt: at } : p);
}

/** Resolve the exact file-read scope before workspace scanning or blob access. */
export function workspaceReviewPaths(task: Task, automaticGrantId?: string): string[] | null {
  // An explicit root grant authorizes this diff read only, without renewing file tools.
  if (assertPermissionAccess(task, 'read_dot_workspace_changes', ['/'], undefined, automaticGrantId)) return null;
  assertPermissionAccess(task, 'list_dot_files', ['/'], undefined, automaticGrantId);
  return assertPermissionAccess(task, 'read_dot_file', [], undefined, automaticGrantId)?.scope.targets ?? null;
}

/** A workspace diff must not become a second route around guarded file/list reads. */
export function assertWorkspaceReviewAccess(task: Task, paths: string[] = [], automaticGrantId?: string): void {
  if (workspaceReviewPaths(task, automaticGrantId) !== null) assertPermissionAccess(task, 'read_dot_file', paths, undefined, automaticGrantId);
}
