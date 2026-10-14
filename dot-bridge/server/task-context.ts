import { z } from 'zod';
import { currentRound, type Task, type Round, type Message } from '../shared/schema';
import { dotBridgeError } from '../shared/errors';

export const CONTEXT_PAGE_CHARS = 24_000;
const RECENT_MESSAGES = 8;
export const historySectionSchema = z.enum(['messages', 'user_messages', 'rounds', 'changes', 'permissions']);
export type HistorySection = z.infer<typeof historySectionSchema>;
export interface HistoryInput {
  section: HistorySection;
  cursor?: string | null;
  roundId?: string | null;
  operationId?: string | null;
  limit?: number;
}
const cursorSchema = z.object({
  taskId: z.string(), revision: z.number().int().nonnegative(), section: historySectionSchema,
  roundId: z.string().nullable(), operationId: z.string().nullable(),
  index: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
}).strict();

/** Exact current decisions plus the latest decision per tool and task-wide guard. No paraphrase. */
export function relevantPermissions(task: Task) {
  const latest = new Map<string, string>();
  for (const p of task.permissions) latest.set(p.scope.toolName, p.requestId);
  const last = task.permissions.at(-1)?.requestId;
  return task.permissions.filter(p => p.roundId === task.currentRoundId || p.requestId === last || latest.get(p.scope.toolName) === p.requestId);
}

function roundContext(round: Round) {
  return {
    roundId: round.roundId, remoteStatus: round.remoteStatus, claim: round.claim,
    baseSha: round.baseSha, targetBranch: round.targetBranch,
    claimedAt: round.claimedAt, claimWait: round.claimWait, stop: round.stop,
    processedThroughSeq: round.processedThroughSeq, dispatchBlocked: round.dispatchBlocked,
    lastProgress: round.lastProgress,
    result: round.result ? { kind: round.result.kind, summary: round.result.summary,
      coversLatest: round.result.coversLatest, updateId: round.result.updateId,
      processedThroughSeq: round.result.processedThroughSeq, reportedAt: round.result.reportedAt } : null,
  };
}

function historyRecords(task: Task, input: HistoryInput): unknown[] {
  const matchesRound = (item: { roundId: string }) => !input.roundId || item.roundId === input.roundId;
  switch (input.section) {
    case 'messages': return task.messages.filter(matchesRound);
    case 'user_messages': return task.messages.filter(m => m.author === 'user' && matchesRound(m));
    case 'rounds': return task.rounds.filter(matchesRound);
    case 'changes': return task.localChanges.filter(c => matchesRound(c) && (!input.operationId || c.operationId === input.operationId));
    case 'permissions': return task.permissions.filter(matchesRound);
  }
}

/** Bounded, lossless pages. Oversized records are split as JSON text, never silently truncated. */
export function taskHistoryPage(task: Task, input: HistoryInput) {
  const identity = { taskId: task.id, revision: task.revision, section: input.section,
    roundId: input.roundId ?? null, operationId: input.operationId ?? null };
  if (input.operationId && input.section !== 'changes') throw dotBridgeError('task-rejected', 'operationId only filters changes');
  let index = 0, offset = 0;
  if (input.cursor) {
    let parsed: z.infer<typeof cursorSchema>;
    try { parsed = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
    catch { throw dotBridgeError('task-rejected', 'Invalid history cursor'); }
    if (parsed.taskId !== task.id || parsed.section !== identity.section || parsed.roundId !== identity.roundId || parsed.operationId !== identity.operationId) {
      throw dotBridgeError('task-rejected', 'History cursor belongs to another task or filter');
    }
    if (parsed.revision !== task.revision) throw dotBridgeError('revision-conflict', 'History changed; restart this history query without a cursor');
    ({ index, offset } = parsed);
  }
  if (input.roundId && !task.rounds.some(r => r.roundId === input.roundId)) throw dotBridgeError('round-missing');
  const records = historyRecords(task, input);
  if (index > records.length || (index === records.length && offset !== 0)) throw dotBridgeError('task-rejected', 'Invalid history offset');
  const entries: Array<{ index: number; value: unknown } | { index: number; jsonFragment: string; offset: number; totalChars: number; complete: boolean }> = [];
  let used = 0;
  while (index < records.length && entries.length < (input.limit ?? 10)) {
    const json = JSON.stringify(records[index]);
    if (offset >= json.length) throw dotBridgeError('task-rejected', 'Invalid history fragment offset');
    if (offset === 0 && json.length <= CONTEXT_PAGE_CHARS - used) {
      entries.push({ index, value: records[index] }); used += json.length; index++;
    } else if (entries.length) break;
    else {
      // Offsets are UTF-16 code units in the serialized JSON, as declared in the response.
      const fragment = json.slice(offset, offset + CONTEXT_PAGE_CHARS);
      const complete = offset + fragment.length === json.length;
      entries.push({ index, jsonFragment: fragment, offset, totalChars: json.length, complete });
      if (complete) { index++; offset = 0; } else offset += fragment.length;
      break;
    }
  }
  const nextCursor = index < records.length ? Buffer.from(JSON.stringify({ ...identity, index, offset })).toString('base64url') : null;
  return { ...identity, total: records.length, entries, nextCursor,
    fragmentInstructions: 'For a fragmented record, concatenate jsonFragment strings in offset order (UTF-16 code units), then JSON.parse after complete=true. Do not treat a partial fragment as a complete instruction or result.' };
}

/** Latest messages for a fresh read; chronological lossless pages for an incremental read. */
function messagePage(task: Task, afterSeq: number | null) {
  if (afterSeq !== null && afterSeq > task.messageSeq) throw dotBridgeError('task-rejected', 'afterSeq is ahead of this task');
  const candidates = afterSeq === null ? task.messages.slice(-RECENT_MESSAGES) : task.messages.filter(m => m.seq > afterSeq);
  const messages: Message[] = [];
  let size = 0;
  for (const message of afterSeq === null ? [...candidates].reverse() : candidates) {
    const chars = JSON.stringify(message).length;
    if (messages.length && (size + chars > CONTEXT_PAGE_CHARS || messages.length >= RECENT_MESSAGES)) break;
    messages.push(message); size += chars;
  }
  if (afterSeq === null) messages.reverse();
  const nextAfterSeq = messages.at(-1)?.seq ?? afterSeq ?? task.messageSeq;
  return { messages, paging: { afterSeq, nextAfterSeq,
    hasMore: nextAfterSeq < task.messageSeq,
    hasOlder: task.messages.some(m => m.seq < (messages[0]?.seq ?? task.messageSeq + 1)),
    total: task.messages.length, returned: messages.length } };
}

export function taskContext(task: Task, afterSeq: number | null = null) {
  const round = currentRound(task), page = messagePage(task, afterSeq);
  const previous = [...task.rounds].reverse().find(r => r.roundId !== round.roundId && r.result);
  const users = afterSeq === null ? taskHistoryPage(task, { section: 'user_messages', limit: 20 }) : null;
  // Current status and exact safety-relevant records are never replaced by generated summaries.
  return {
    task: {
      id: task.id, title: task.title, mode: task.mode, connectionId: task.connectionId,
      repository: task.repository, remoteName: task.remoteName, branch: task.branch,
      workspaceId: task.workspaceId, workspaceRoot: task.workspaceRoot, remoteOrigin: task.remoteOrigin,
      requirement: task.requirement, acceptance: task.acceptance,
      provider: task.provider ? { cwd: task.provider.cwd } : null, environmentHint: task.environmentHint,
      currentRoundId: task.currentRoundId, status: task.status, cancelRequested: task.cancelRequested,
      messageSeq: task.messageSeq, userMessageSeq: task.userMessageSeq, revision: task.revision,
      rounds: [roundContext(round)], messages: page.messages,
      attachments: task.attachments, permissions: relevantPermissions(task),
    },
    context: {
      view: 'working-context', messagePage: page.paging,
      userInstructions: users,
      latestPriorResult: previous?.result ? { roundId: previous.roundId, summary: previous.result.summary,
        coversLatest: previous.result.coversLatest, reportedAt: previous.result.reportedAt } : null,
      recentChanges: task.localChanges.slice(-3).map(c => ({ operationId: c.operationId, roundId: c.roundId,
        status: c.status, at: c.at, fileCount: c.files.length, conflictCount: c.conflicts.length })),
      totals: { rounds: task.rounds.length, changes: task.localChanges.length, permissions: task.permissions.length },
      historyTool: 'get_dot_task_history',
      instructions: 'This is a partial working view, not the complete task archive. On a fresh read, userInstructions contains exact user messages; before acting, read all its pages with section=user_messages if nextCursor is non-null, and reconcile earlier restrictions with newer instructions. Incremental reads set userInstructions=null and rely on your previously read constraints; if that context is lost, call get_dot_task without afterSeq or knownGuidanceVersion. Previous user instructions remain applicable unless explicitly changed; no generated summary can grant permission. For older messages/results use get_dot_task_history. Before retrying an uncertain file write, query section=changes with operationId; recentChanges is only an index and missing entries are not proof of no write. For follow-up messages use get_dot_task(afterSeq=last nextAfterSeq) until hasMore=false. Update processedThroughSeq only through user input actually read and handled, not merely the latest sequence number.',
    },
  };
}

/** Polling never replays message bodies, old results, or operation payloads. */
export function taskStatus(task: Task) {
  const round = currentRound(task);
  return {
    taskId: task.id, revision: task.revision, currentRoundId: task.currentRoundId,
    status: task.status, messageSeq: task.messageSeq, userMessageSeq: task.userMessageSeq,
    processedThroughSeq: round.processedThroughSeq, cancelRequested: task.cancelRequested,
    claim: round.claim, stop: round.stop, claimWait: round.claimWait, dispatchBlocked: round.dispatchBlocked,
    progress: round.lastProgress ? { kind: round.lastProgress.kind, at: round.lastProgress.at, processedThroughSeq: round.lastProgress.processedThroughSeq } : null,
    result: round.result ? { updateId: round.result.updateId, coversLatest: round.result.coversLatest } : null,
    permissions: relevantPermissions(task).map(p => ({ requestId: p.requestId, roundId: p.roundId,
      userMessageSeq: p.userMessageSeq, toolName: p.scope.toolName, status: p.status,
      consumedAt: p.consumedAt, platformBlock: p.platformBlock })),
    instructions: 'Status only: message bodies, permission scopes and result content are omitted. When revision, userMessageSeq or guidanceVersion changes, read get_dot_task before acting; status is not authorization. Use afterSeq only with an already-read context, and consume all returned message pages.',
  };
}
