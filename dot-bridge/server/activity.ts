import { randomUUID } from 'node:crypto';
import { ATTACHMENT_CHUNK_BYTES } from '../shared/attachments';
import { explain } from '../shared/errors';
import type { ToolName } from '../shared/mcp';
import type { Task } from '../shared/schema';

/**
 * One thing Dot did through the Bridge, shown live in the native Paseo conversation. Paseo keeps
 * what it has displayed, so this log only lives as long as the plugin process and never affects
 * a tool's outcome. File edits are not recorded here: their cards come from durable receipts.
 */
export interface DotActivity {
  id: string;
  taskId: string;
  roundId: string;
  at: number;
  kind: 'read-task' | 'list' | 'read' | 'read-attachment' | 'upload' | 'apply-failed';
  /** A relative path, directory or attachment name. */
  target: string;
  status: 'running' | 'completed' | 'failed';
  /** Chunk progress, a directory listing, or the reason a call was refused. */
  detail: string;
}

const MAX_PER_TASK = 200;
const MAX_DETAIL = 4000;

export class ActivityLog {
  private readonly byTask = new Map<string, DotActivity[]>();

  /** A repeated id updates its entry in place and keeps the original time, so the card does not move. */
  record(entry: DotActivity): void {
    const list = this.byTask.get(entry.taskId) ?? [];
    const index = list.findIndex(item => item.id === entry.id);
    if (index >= 0) list[index] = { ...entry, at: list[index]!.at };
    else list.push(entry);
    if (list.length > MAX_PER_TASK) list.splice(0, list.length - MAX_PER_TASK);
    this.byTask.set(entry.taskId, list);
  }

  list(taskId: string): readonly DotActivity[] {
    return this.byTask.get(taskId) ?? [];
  }
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const matched = /^dot-bridge-error:([a-z0-9-]+)(?:\n([\s\S]*))?$/.exec(message);
  return (matched ? explain(matched[1]!, matched[2], 'zh-CN') : message).slice(0, MAX_DETAIL);
}

const chunks = (size: number) => Math.max(1, Math.ceil(size / ATTACHMENT_CHUNK_BYTES));

/** Maps a finished tool call to its activity entry; calls without a visible effect return null. */
export function describeToolCall(name: ToolName, input: Record<string, unknown>, outcome: { result?: unknown; error?: unknown }, task: Task, at: number): DotActivity | null {
  const failed = 'error' in outcome;
  const status = failed ? 'failed' as const : 'completed' as const;
  const error = failed ? failure(outcome.error) : '';
  const roundId = typeof input.roundId === 'string' ? input.roundId : task.currentRoundId;
  const base = { taskId: task.id, roundId, at };
  switch (name) {
    case 'get_dot_task':
      // One card per user message: re-reading the same message is not new activity.
      if (failed) return null;
      const read = (outcome.result as { task: Task }).task;
      return { ...base, id: `${task.id}:read-task:${read.currentRoundId}:${read.userMessageSeq}`, roundId: read.currentRoundId, kind: 'read-task', target: '', status, detail: '' };
    case 'list_dot_files': {
      const result = outcome.result as { entries: Array<{ path: string; type: string }>; nextOffset: number | null } | undefined;
      const listing = result ? [...result.entries.map(entry => (entry.type === 'directory' ? `${entry.path}/` : entry.path)), ...(result.nextOffset !== null ? ['…'] : [])].join('\n') : '';
      return { ...base, id: randomUUID(), kind: 'list', target: String(input.directory || '.'), status, detail: (failed ? error : listing).slice(0, MAX_DETAIL) };
    }
    case 'read_dot_file':
      return { ...base, id: randomUUID(), kind: 'read', target: String(input.path), status, detail: error };
    case 'read_dot_workspace_changes': {
      const result = outcome.result as { isGitRepository: boolean; files: Array<{ path: string; indexStatus: string; worktreeStatus: string; omittedReason: string | null; diffTruncated: boolean }>; nextOffset: number | null; note: string } | undefined;
      const listing = result ? (result.isGitRepository ? [...result.files.map(file => `${file.indexStatus}${file.worktreeStatus} ${file.path}${file.omittedReason ? ' (diff unavailable)' : file.diffTruncated ? ' (diff truncated)' : ''}`), ...(result.nextOffset !== null ? ['…'] : [])].join('\n') : result.note) : '';
      return { ...base, id: randomUUID(), kind: 'list', target: 'Git changes', status, detail: (failed ? error : listing).slice(0, MAX_DETAIL) };
    }
    case 'read_dot_attachment':
    case 'read_dot_attachment_chunk': {
      if (failed) return null;
      const attachment = (outcome.result as { attachment: { id: string; name: string; size: number } }).attachment;
      const progress = name === 'read_dot_attachment_chunk' ? `${Number(input.index) + 1}/${chunks(attachment.size)}` : '';
      return { ...base, id: `${task.id}:attachment-read:${task.currentRoundId}:${attachment.id}`, roundId: task.currentRoundId, kind: 'read-attachment', target: attachment.name, status, detail: progress };
    }
    case 'upload_dot_attachment_chunk': {
      const id = `${task.id}:upload:${String(input.operationId)}`;
      if (failed) return { ...base, id, kind: 'upload', target: String(input.name), status, detail: error };
      const result = outcome.result as { complete: boolean; received: number[] };
      return { ...base, id, kind: 'upload', target: String(input.name), status: result.complete ? 'completed' : 'running', detail: `${result.received.length}/${chunks(Number(input.size))}` };
    }
    case 'upload_dot_attachment':
      // A successful upload already appears as its attachment card.
      return failed ? { ...base, id: `${task.id}:upload:${String(input.operationId)}`, kind: 'upload', target: String(input.name), status, detail: error } : null;
    case 'apply_dot_changes': {
      // Applied, partial and conflicting batches all have durable receipts; only refused calls land here.
      if (!failed) return null;
      const paths = (input.changes as Array<{ path: string }>).map(change => change.path).join(', ');
      return { ...base, id: `${task.id}:apply:${String(input.operationId)}`, kind: 'apply-failed', target: paths.slice(0, 1000), status, detail: error };
    }
    default:
      return null;
  }
}
