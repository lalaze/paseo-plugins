import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { taskCollaborationSchema, unavailableCatalog, type CollaborationCatalog, type CollaborationState, type TaskCollaboration } from '../shared/collaboration';
import { explain, todoError, type TodoErrorCode, type TodoFailure } from '../shared/errors';
import { canAccept, canCancel, canContinue, canEnqueue, canRetry, isExecution, recoverExecution, reduceCollaboration, reducePermission, reduceTurn, type CollaborationDecision, type CollaborationObservation, type TurnKind } from '../shared/machine';
import { reviewBindingSchema, reviewsMatch, taskSchema, type ReviewBinding, type Task, type TaskDiff, type TaskOutcome } from '../shared/schema';
import type { AgentInspection, AgentPort } from './agents';
import type { CollaborationPort } from './collaboration';
import type { GitPort } from './git';
import type { TaskStore } from './store';

const EMPTY_DIFF: TaskDiff = { patch: '', files: [], truncated: false };
/** Turn-event dedup keys are kept insertion-ordered and evicted past this size. */
const CONSUMED_LIMIT = 1000;
/** Backstop for startedTurn entries a terminal-state cleanup did not reach (older rounds' agents). */
const STARTED_TURN_LIMIT = 1000;
/** Background throttles measured on the monotonic clock; required syncs (accept, read, turn events) bypass them. */
const SYNC_MIN_INTERVAL = 1000;
const RECONCILE_MIN_INTERVAL = 5000;

export interface TurnEvent {
  agentId: string;
  turnId: string | null;
  outcome: { kind: TurnKind; error?: string | null };
}

export interface TurnStartedEvent {
  agentId: string;
  turnId: string | null;
}

export interface CreateTaskInput {
  title: string;
  prompt: string;
  repository: string;
  projectId: string | null;
  projectName: string | null;
  targetBranch: string;
  provider: string;
  modeId: string | null;
  collaboration?: TaskCollaboration | null;
}

export interface TodoEngineOptions {
  store: TaskStore;
  git: GitPort;
  agents: AgentPort;
  collaboration?: CollaborationPort;
  now?: () => number;
  newId?: () => string;
  /** Monotonic clock for background throttles; `now` stays the source for timestamps written to tasks. */
  clock?: () => number;
  /** Test hook: override the startedTurn backstop size. */
  startedTurnLimit?: number;
}

function requireCollaboration(value: TaskCollaboration | null | undefined): TaskCollaboration | null {
  if (value == null) return null;
  const parsed = taskCollaborationSchema.safeParse(value);
  if (!parsed.success) throw todoError('collaboration-invalid', parsed.error.issues.map(issue => issue.message).join('; '));
  return parsed.data;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureCode(error: unknown): TodoErrorCode | null {
  return error instanceof Error && typeof (error as TodoFailure).code === 'string' ? (error as TodoFailure).code : null;
}

/** A sent-back round runs in a new session, so it gets the original task along with the requested change. */
export function followUpPrompt(original: string, followUp: string): string {
  return [
    original,
    '',
    '---',
    '这个工作树里已经有你上一轮为上面这个任务做的修改。验收时被打回，要求如下：',
    '',
    followUp,
  ].join('\n');
}

function collaborationError(code: string | null): boolean {
  return code === 'collaboration-unavailable'
    || code === 'collaboration-blocked'
    || code === 'collaboration-acceptance-pending'
    || code === 'collaboration-rejected'
    || code === 'collaboration-declined'
    || code === 'collaboration-deferred';
}

function conversationOf(state: CollaborationState, task: Task) {
  return state.conversations.find(entry => entry.id === task.collaborationConversationId)
    ?? state.conversations.find(entry => task.operationId !== null && entry.requestId === task.operationId)
    ?? null;
}

function mergeError(reason: string): TodoErrorCode {
  if (reason === 'conflict') return 'merge-conflict';
  if (reason === 'dirty') return 'merge-dirty';
  if (reason === 'stale-target' || reason === 'stale-result') return 'binding-stale';
  return 'merge-verify';
}

/**
 * One process owns the queue. A repository runs one task at a time.
 * A merge happens only from accept(), and only when the binding on screen matches the saved one.
 */
export class TodoEngine {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly clock: () => number;
  private readonly startedTurnLimit: number;
  private readonly listeners = new Set<() => void>();
  private readonly repoTails = new Map<string, Promise<void>>();
  private readonly gitTails = new Map<string, Promise<void>>();
  private readonly taskTails = new Map<string, Promise<void>>();
  private readonly turns: TurnEvent[] = [];
  private readonly consumed = new Set<string>();
  private readonly startedTurn = new Map<string, string | null>();
  private readonly permissions = new Map<string, Set<string>>();
  private readonly preparing = new Set<string>();
  private readonly collaborationSyncs = new Map<string, Promise<void>>();
  private readonly collaborationSyncedAt = new Map<string, number>();
  private readonly reconciles = new Map<string, Promise<void>>();
  private readonly reconciledAt = new Map<string, number>();
  private readonly collaborationRecoveries = new Map<string, Promise<void>>();
  private readonly collaborationPoll: ReturnType<typeof setInterval>;
  private readonly idleWaiters: Array<() => void> = [];
  private spanDepth = 0;
  private draining = false;
  private disposed = false;
  private closed = false;

  constructor(private readonly options: TodoEngineOptions) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => randomUUID());
    this.clock = options.clock ?? (() => performance.now());
    this.startedTurnLimit = options.startedTurnLimit ?? STARTED_TURN_LIMIT;
    this.collaborationPoll = setInterval(() => this.watchCollaborations(), 2000);
    this.collaborationPoll.unref();
  }

  /** The saved board. Also starts a collaboration poll so phases do not wait for the next interval. */
  list() {
    this.watchCollaborations();
    return { tasks: this.options.store.list(), loadError: this.options.store.loadError, dataDir: this.options.store.dir };
  }

  /** Tasks store the resolved repository root, so a workspace path is resolved the same way before comparing. */
  async listIn(path: string) {
    const repository = await this.options.git.resolveRepository(path);
    const listed = this.list();
    return { ...listed, tasks: listed.tasks.filter(task => task.repository === repository) };
  }

  /** Save a draft. Does not open a worktree or a session. */
  async createTask(input: CreateTaskInput): Promise<Task> {
    if (this.disposed) throw todoError('store-invalid');
    this.ensureWritable();
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    if (!title || !prompt) throw todoError('empty-prompt');
    if (!isAbsolute(input.repository)) throw todoError('not-git');
    const repository = await this.options.git.resolveRepository(input.repository);
    if (!await this.options.git.branchExists(repository, input.targetBranch)) throw todoError('branch-missing');
    const now = this.now();
    const task = taskSchema.parse({
      id: this.newId(), title, prompt, pendingPrompt: null, repository,
      projectId: input.projectId, projectName: input.projectName, targetBranch: input.targetBranch,
      provider: input.provider, modeId: input.modeId, collaboration: requireCollaboration(input.collaboration),
      collaborationConversationId: null, collaborationRunId: null, collaborationPhase: null, collaborationControl: null,
      collaborationAcceptance: null, status: 'draft', branch: null, worktree: null,
      baseCommit: null, agentId: null, workspaceId: null, operationId: null, operationIds: [],
      review: null, lastOutcome: null, pendingMergeCommit: null, mergeCommit: null, mergeMethod: null,
      errorCode: null, errorDetail: null, createdAt: now, updatedAt: now,
    });
    await this.options.store.insert(task);
    return task;
  }

  /** Queue every draft in one repository, or every draft when repository is null. */
  async startQueue(repository: string | null): Promise<Task[]> {
    if (this.disposed) throw todoError('store-invalid');
    this.ensureWritable();
    const root = repository ? await this.options.git.resolveRepository(repository) : null;
    // Re-read under the task lock: a cancel that lands while earlier drafts are being written must not be overwritten.
    for (const { id } of this.options.store.list()) {
      await this.lockTask(id, async () => {
        const task = this.options.store.tryGet(id);
        if (!task || !canEnqueue(task.status) || (root && task.repository !== root)) return;
        await this.write({ ...task, status: 'queued', errorCode: null, errorDetail: null });
      });
    }
    this.tick();
    return this.options.store.list();
  }

  /** Queue one draft. The collaboration snapshot already saved on it is what will run. */
  async startTask(id: string): Promise<Task> {
    if (this.disposed) throw todoError('store-invalid');
    this.ensureWritable();
    await this.lockTask(id, async () => {
      const task = this.options.store.get(id);
      if (!canEnqueue(task.status)) throw todoError('start-rejected');
      await this.write({ ...task, status: 'queued', errorCode: null, errorDetail: null });
    });
    this.tick();
    return this.options.store.get(id);
  }

  /** Replace the snapshot on an unstarted draft. A task that already has an operation id is refused. */
  async updateCollaboration(id: string, collaboration: TaskCollaboration | null): Promise<Task> {
    if (this.disposed) throw todoError('store-invalid');
    this.ensureWritable();
    return this.lockTask(id, async () => {
      const task = this.options.store.get(id);
      if (task.status !== 'draft' || task.operationId) throw todoError('collaboration-rejected');
      const next = requireCollaboration(collaboration);
      const clearDeferred = task.errorCode === 'collaboration-deferred';
      return this.write({
        ...task,
        collaboration: next,
        errorCode: clearDeferred ? null : task.errorCode,
        errorDetail: clearDeferred ? null : task.errorDetail,
      });
    });
  }

  /** Host capabilities for the form. A host without collaboration returns a catalog error instead of throwing. */
  async collaborationCatalog(): Promise<CollaborationCatalog> {
    if (!this.options.collaboration) return unavailableCatalog(explain('collaboration-unavailable'));
    return this.options.collaboration.catalog();
  }

  async read(id: string): Promise<{ task: Task; diff: TaskDiff }> {
    // Required: an in-flight board poll may have snapshotted the run before this read. Wait for it, then fetch again.
    await this.syncCollaboration(id, { required: true }).catch(() => undefined);
    await this.reconcile(id).catch(() => undefined);
    const task = this.options.store.get(id);
    if (!task.worktree || !task.branch) return { task, diff: EMPTY_DIFF };
    const from = task.review?.targetHead ?? task.baseCommit;
    if (!from) return { task, diff: EMPTY_DIFF };
    try {
      const diff = await this.options.git.diff({
        root: task.repository, worktree: task.worktree, branch: task.branch, from, to: task.review?.resultCommit ?? null,
      });
      return { task: this.options.store.get(id), diff };
    } catch (error) {
      return { task: this.options.store.get(id), diff: { patch: errorText(error).slice(0, 4000), files: [], truncated: false } };
    }
  }

  /** A draft is canceled immediately. A live run stays canceling until its agent and collaboration run stop. */
  async cancel(id: string): Promise<Task> {
    if (this.disposed) throw todoError('cancel-rejected');
    let agentId: string | null = null;
    let operationId: string | null = null;
    let execution = false;
    await this.lockTask(id, async () => {
      const task = this.options.store.get(id);
      if (task.status === 'merging' || task.status === 'canceling' || !canCancel(task.status)) throw todoError('cancel-rejected');
      // A paused or blocked collaboration is not in the execution slot, but its host run can still
      // have child sessions. Cancel those before the task is marked canceled.
      const liveCollaboration = Boolean(task.collaboration && task.operationId && (task.collaborationConversationId || task.collaborationRunId));
      if (!isExecution(task.status) && !liveCollaboration) {
        await this.write({ ...task, status: 'canceled', errorCode: null, errorDetail: null });
        return;
      }
      await this.write({ ...task, status: 'canceling' });
      agentId = task.agentId;
      operationId = task.operationId;
      execution = true;
    });
    // A prepare still inside ensure/create settles itself. Settling here with no agent
    // would mark the task canceled before that create returns.
    if (execution && operationId && (agentId || !this.preparing.has(id))) await this.settleCancel(id, operationId, agentId);
    this.tick();
    return this.options.store.get(id);
  }

  /** A blocked collaboration keeps its run and waits for the repository slot. Anything else stops the old run first. */
  async retry(id: string): Promise<Task> {
    if (this.disposed) throw todoError('retry-rejected');
    this.ensureWritable();
    await this.lockTask(id, async () => {
      const current = this.options.store.get(id);
      if (!canRetry(current.status)) throw todoError('retry-rejected');
      if (current.collaboration && current.collaborationRunId && current.collaborationControl === 'needs_attention') {
        if (!this.options.collaboration) throw todoError('collaboration-unavailable');
        // Keep this run, but let the repository queue reserve its execution slot before resuming it.
        await this.write({ ...current, status: 'queued', review: null, lastOutcome: null, errorCode: null, errorDetail: null });
        return;
      }
      if (current.collaboration) await this.releaseCollaboration(current);
      const latest = this.options.store.get(id);
      if (!canRetry(latest.status)) throw todoError('retry-rejected');
      await this.write(this.requeue(latest, null));
    });
    this.tick();
    return this.options.store.get(id);
  }

  /** Queue another round with the follow-up. Stops the previous collaboration run before the new session opens. */
  async continue(id: string, prompt: string): Promise<Task> {
    if (this.disposed) throw todoError('continue-rejected');
    this.ensureWritable();
    const pendingPrompt = prompt.trim();
    if (!pendingPrompt) throw todoError('empty-prompt');
    const task = this.options.store.get(id);
    if (!canContinue(task.status)) throw todoError('continue-rejected');
    await this.lockTask(id, async () => {
      const current = this.options.store.get(id);
      if (!canContinue(current.status)) throw todoError('continue-rejected');
      if (current.collaboration && followUpPrompt(current.prompt, pendingPrompt).length > 32_000) {
        throw todoError('collaboration-invalid', '原任务和修改意见合计超过主机协作目标的 32000 字限制');
      }
      if (current.collaboration) await this.releaseCollaboration(current);
      const latest = this.options.store.get(id);
      if (!canContinue(latest.status)) throw todoError('continue-rejected');
      await this.write(this.requeue(latest, pendingPrompt));
    });
    this.tick();
    return this.options.store.get(id);
  }

  /** Merge is reachable only from this method, and only after the displayed binding matches the saved one. */
  async accept(id: string, review: ReviewBinding): Promise<Task> {
    if (this.disposed) throw todoError('accept-rejected');
    const task = this.options.store.get(id);
    if (task.collaboration) {
      await this.syncCollaboration(id, { required: true });
      const synced = this.options.store.get(id);
      if (synced.collaborationAcceptance !== 'accepted') {
        throw todoError(synced.status === 'canceled' ? 'collaboration-declined' : 'collaboration-acceptance-pending');
      }
    }
    const release = this.enter();
    if (!release) throw todoError('accept-rejected');
    try {
      const agentId = await this.lockTask(id, async () => {
        const displayed = reviewBindingSchema.parse(review);
        const current = this.options.store.get(id);
        if (!canAccept(current.status) || !current.review || !current.worktree || !current.branch) throw todoError('accept-rejected');
        if (!reviewsMatch(current.review, displayed)) throw todoError('stale-client-review');
        return current.agentId;
      });
      await this.assertAgentIdle(agentId);
      // The merge shares the short git lock with worktree setup and capture, not the execution slot, so another
      // task running in the same repository does not hold an accept for the length of its turn.
      const result = await this.lockTask(id, () => this.gitSerial(task.repository, () => this.acceptLocked(id, review)));
      this.tick();
      // The merge stands on its own; a cleanup step that fails is recorded on the task and can be retried.
      return result.status === 'merged' ? await this.cleanup(id).catch(() => this.options.store.get(id)) : result;
    } finally {
      release();
    }
  }

  /**
   * After a merge: archive the task's sessions and workspace, then remove its worktree, then delete its branch. Each step
   * runs only once the one before it succeeded (a live session may still be using the worktree, and git will not delete
   * a branch a worktree has checked out); finished steps are skipped on a retry.
   */
  async cleanup(id: string): Promise<Task> {
    if (this.disposed) throw todoError('cleanup-rejected');
    this.ensureWritable();
    const release = this.enter();
    if (!release) throw todoError('cleanup-rejected');
    try {
      const task = this.options.store.get(id);
      if (task.status !== 'merged') throw todoError('cleanup-rejected');
      const done = { sessions: task.cleanup?.sessions ?? false, worktree: task.cleanup?.worktree ?? false, branch: task.cleanup?.branch ?? false };
      let problem: string | null = null;
      // The failed step is the first one not done, so only its error is kept; the page names the step.
      const step = async (fn: () => Promise<void>) => {
        try { await fn(); return true; } catch (error) { problem = errorText(error).slice(0, 4000); return false; }
      };
      if (!done.sessions) {
        done.sessions = await step(() => this.options.agents.archiveTask({ taskId: task.id, workspaceId: task.workspaceId, worktree: task.worktree }));
      }
      if (done.sessions && !done.worktree) {
        const { worktree, branch } = task;
        done.worktree = !worktree || !branch || await step(() => this.gitSerial(task.repository, () => this.options.git.removeWorktree({ root: task.repository, worktree, branch })));
      }
      if (done.worktree && !done.branch) {
        const { branch, review } = task;
        done.branch = !branch || await step(async () => {
          if (!review) throw new Error('没有记录验收时的成果提交');
          await this.gitSerial(task.repository, () => this.options.git.deleteMergedBranch({
            root: task.repository, branch, expectedHead: review.resultCommit, targetBranch: review.targetBranch,
          }));
        });
      }
      return await this.lockTask(id, async () => {
        const current = this.options.store.get(id);
        return this.write({ ...current, cleanup: { ...done, error: problem, at: this.now() } });
      });
    } finally {
      release();
    }
  }

  /** A new turn on a finished single-agent session invalidates its review binding. Collaboration does not use this. */
  async onTurnStarted(event: TurnStartedEvent): Promise<void> {
    if (this.disposed) return;
    // Re-insert so the map stays in recency order: the front is the agent idle longest, never one mid-turn.
    this.startedTurn.delete(event.agentId);
    this.startedTurn.set(event.agentId, event.turnId);
    while (this.startedTurn.size > this.startedTurnLimit) this.startedTurn.delete(this.startedTurn.keys().next().value as string);
    const task = this.options.store.findByAgent(event.agentId);
    if (!task || task.collaboration) return;
    if (task.status !== 'awaiting_review' && task.status !== 'merge_failed') return;
    await this.lockTask(task.id, async () => {
      const current = this.options.store.get(task.id);
      if (current.agentId !== event.agentId) return;
      if ((current.status !== 'awaiting_review' && current.status !== 'merge_failed') || !current.review) return;
      if (event.turnId && event.turnId === current.review.turnId) return;
      await this.write({
        ...current, status: 'needs_check', review: null, errorCode: 'binding-stale',
        errorDetail: '会话又开始了一轮，旧的验收绑定已失效',
      });
    });
  }

  /** Record the turn, then advance the task. A collaboration run is advanced by the host poll, not by this event alone. */
  async onTurnEnded(event: TurnEvent): Promise<void> {
    if (this.disposed) return;
    if (!this.remember(event)) return;
    await this.dispatchTurn(event);
  }

  /** Single-agent permission. A collaboration task takes its permission state from the host run. */
  async onPermissionRequested(agentId: string, requestId: string): Promise<void> {
    if (this.disposed) return;
    const pending = this.permissions.get(agentId) ?? new Set<string>();
    pending.add(requestId);
    this.permissions.set(agentId, pending);
    await this.applyPermission(agentId);
  }

  async onPermissionResolved(agentId: string, requestId: string): Promise<void> {
    if (this.disposed) return;
    this.permissions.get(agentId)?.delete(requestId);
    await this.applyPermission(agentId);
  }

  /** Needs permission while any request is open; resolving one of two leaves the agent blocked on the other. */
  private async applyPermission(agentId: string): Promise<void> {
    const pending = (this.permissions.get(agentId)?.size ?? 0) > 0;
    const task = this.options.store.findByAgent(agentId);
    // Collaboration permission comes from the host run, not one main-agent permission request.
    if (!task || task.collaboration) {
      if (!pending) this.permissions.delete(agentId);
      return;
    }
    await this.lockTask(task.id, async () => {
      const current = this.options.store.get(task.id);
      const next = reducePermission(current.status, pending);
      if (next !== current.status) await this.write({ ...current, status: next });
    });
    if (!pending) this.permissions.delete(agentId);
  }

  /** Reattach sessions after a restart. Does not send the prompt again. */
  async recover(): Promise<void> {
    if (this.options.store.loadError) return;
    for (const task of this.options.store.list()) await this.recoverOne(task.id);
    for (const task of this.options.store.list()) {
      if (isExecution(task.status)) void this.exclusive(task.repository, () => this.waitUntil(task.id, item => !isExecution(item.status)));
    }
    this.tick();
  }

  /** Stop the poll, wait for in-flight work, then release the store lock. */
  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.collaborationPoll);
    this.draining = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
    await this.whenIdle();
    this.closed = true;
    await this.options.store.dispose();
  }

  private ensureWritable(): void {
    if (this.options.store.loadError) {
      throw todoError(this.options.store.loadError === 'store-locked' ? 'store-locked' : 'store-invalid');
    }
  }

  private async acceptLocked(id: string, review: ReviewBinding): Promise<Task> {
    const displayed = reviewBindingSchema.parse(review);
    const task = this.options.store.get(id);
    if (!canAccept(task.status) || !task.review || !task.worktree || !task.branch) throw todoError('accept-rejected');
    if (task.collaboration && task.collaborationAcceptance !== 'accepted') throw todoError('collaboration-acceptance-pending');
    if (!reviewsMatch(task.review, displayed)) throw todoError('stale-client-review');
    if (!task.collaboration) {
      const started = task.agentId ? this.startedTurn.get(task.agentId) : undefined;
      if (started && started !== task.review.turnId) throw todoError('agent-busy');
    }
    const binding = task.review;
    await this.write({ ...task, status: 'merging', pendingMergeCommit: null, errorCode: null, errorDetail: null });
    try {
      return await this.merge(id, task, binding);
    } catch (error) {
      return this.settleThrownMerge(id, binding, error);
    }
  }

  private async merge(id: string, task: Task, binding: ReviewBinding): Promise<Task> {
    if (!task.worktree || !task.branch) throw todoError('accept-rejected');
    const prepared = await this.options.git.prepareMerge({
      root: task.repository,
      worktree: task.worktree,
      taskBranch: task.branch,
      targetBranch: binding.targetBranch,
      expectedTargetHead: binding.targetHead,
      resultCommit: binding.resultCommit,
      resultTree: binding.resultTree,
      message: `paseo-todo: accept ${task.title}\n\nTask: ${task.id}\nResult: ${binding.resultCommit}`,
    });
    if (!prepared.ok) {
      return this.write({ ...this.options.store.get(id), status: 'merge_failed', errorCode: mergeError(prepared.reason), errorDetail: prepared.detail.slice(0, 4000) });
    }
    await this.write({ ...this.options.store.get(id), pendingMergeCommit: prepared.mergeCommit });
    const applied = await this.options.git.applyMerge(prepared);
    const current = this.options.store.get(id);
    if (current.status !== 'merging') return current;
    if (!applied.ok) {
      return this.write({ ...current, status: 'merge_failed', errorCode: mergeError(applied.reason), errorDetail: applied.detail.slice(0, 4000) });
    }
    return this.write({
      ...current, status: 'merged', mergeCommit: applied.mergeCommit, mergeMethod: applied.method,
      pendingMergeCommit: applied.mergeCommit, errorCode: null, errorDetail: null,
    });
  }

  /**
   * An exception says nothing about whether the ref moved, so the target ref decides, as it does after a restart:
   * already at the precomputed commit is merged, still at the bound HEAD can be accepted again, anything else is checked by hand.
   */
  private async settleThrownMerge(id: string, binding: ReviewBinding, error: unknown): Promise<Task> {
    const current = this.options.store.get(id);
    if (current.status !== 'merging') return current;
    const detail = errorText(error).slice(0, 4000);
    let target: string;
    try {
      target = await this.options.git.readTargetHead(current.repository, binding.targetBranch);
    } catch (readError) {
      return this.write({ ...current, status: 'needs_check', errorCode: 'interrupted-merge', errorDetail: `${detail}\n${errorText(readError)}`.slice(0, 4000) });
    }
    if (current.pendingMergeCommit && target === current.pendingMergeCommit) {
      return this.write({ ...current, status: 'merged', mergeCommit: target, errorCode: null, errorDetail: null });
    }
    if (target === binding.targetHead) {
      return this.write({ ...current, status: 'merge_failed', pendingMergeCommit: null, errorCode: 'merge-verify', errorDetail: detail });
    }
    return this.write({ ...current, status: 'needs_check', review: null, errorCode: 'binding-stale', errorDetail: detail });
  }

  private async recoverOne(id: string): Promise<void> {
    const task = this.options.store.tryGet(id);
    if (!task) return;
    if (task.status === 'merging') {
      if (!task.review) {
        await this.write({ ...task, status: 'needs_check', errorCode: 'interrupted-merge', errorDetail: null });
        return;
      }
      try {
        const target = await this.options.git.readTargetHead(task.repository, task.targetBranch);
        if (task.pendingMergeCommit && target === task.pendingMergeCommit) {
          await this.write({ ...task, status: 'merged', mergeCommit: task.pendingMergeCommit, errorCode: null, errorDetail: null });
        } else if (target === task.review.targetHead) {
          await this.write({ ...task, status: 'awaiting_review', pendingMergeCommit: null, errorCode: 'interrupted-merge', errorDetail: '合并没有自动重试' });
        } else {
          await this.write({ ...task, status: 'needs_check', review: null, errorCode: 'binding-stale', errorDetail: '合并中断且目标分支已变化' });
        }
      } catch (error) {
        await this.write({ ...task, status: 'needs_check', errorCode: 'interrupted-merge', errorDetail: errorText(error).slice(0, 4000) });
      }
      return;
    }
    if (task.status === 'canceling') {
      // Finish the cancel rather than re-deriving the status from the session: a live session must not turn back into running.
      if (!task.operationId) await this.write({ ...task, status: 'canceled', errorCode: 'turn-canceled', errorDetail: null });
      else await this.settleCancel(id, task.operationId, task.agentId);
      return;
    }
    if (task.collaboration && isExecution(task.status)) {
      await this.recoverCollaboration(id);
      return;
    }
    if (!isExecution(task.status)) return;
    if (!task.operationId) {
      await this.write({ ...task, status: 'needs_check', errorCode: 'needs-check-no-operation', errorDetail: null });
      return;
    }
    if (task.lastOutcome?.operationId === task.operationId) {
      await this.applyStoredOutcome(task.id);
      return;
    }
    let agentId = task.agentId;
    if (!agentId) {
      try {
        agentId = await this.options.agents.findByOperation(task.operationId);
      } catch (error) {
        await this.write({ ...this.options.store.get(id), errorCode: 'gateway-unavailable', errorDetail: errorText(error).slice(0, 4000) });
        return;
      }
    }
    if (!agentId) {
      await this.write({ ...this.options.store.get(id), status: 'needs_check', errorCode: 'needs-check-no-agent', errorDetail: null });
      return;
    }
    let inspection;
    try { inspection = await this.options.agents.inspect(agentId); }
    catch (error) {
      const decision = recoverExecution({ hasOperation: true, exists: true, active: true, permission: false, gatewayFailed: true });
      if (decision.redispath || decision.status !== 'unchanged') return;
      await this.write({ ...this.options.store.get(id), agentId, errorCode: 'gateway-unavailable', errorDetail: errorText(error).slice(0, 4000) });
      return;
    }
    const decision = recoverExecution({
      hasOperation: true, exists: inspection.exists, active: inspection.active, permission: inspection.permission, gatewayFailed: false,
    });
    const current = this.options.store.get(id);
    if (decision.status === 'needs_check') {
      await this.write({
        ...current, agentId, status: 'needs_check',
        errorCode: inspection.exists ? 'needs-check-no-outcome' : 'needs-check-missing-session',
        errorDetail: null,
      });
      return;
    }
    if (decision.status === 'unchanged') return;
    await this.write({ ...current, agentId, status: decision.status, errorCode: null, errorDetail: null });
  }

  private async applyStoredOutcome(id: string): Promise<void> {
    const task = this.options.store.get(id);
    const outcome = task.lastOutcome;
    if (!outcome || !isExecution(task.status)) return;
    if (outcome.kind !== 'completed') {
      await this.write({
        ...task,
        status: outcome.kind === 'failed' ? 'failed' : 'canceled',
        errorCode: outcome.kind === 'failed' ? 'turn-failed' : 'turn-canceled',
        errorDetail: null,
      });
      return;
    }
    await this.write({ ...task, status: 'needs_check', errorCode: 'needs-check-no-outcome', errorDetail: '已记录完成，但重启后没有重新固化或派发' });
  }

  private tick(): void {
    if (this.disposed || this.closed || this.options.store.loadError) return;
    const tasks = this.options.store.list().sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const busy = new Set(tasks.filter(task => isExecution(task.status) || task.status === 'merging').map(task => task.repository));
    const seen = new Set<string>();
    for (const task of tasks) {
      if (task.status !== 'queued' || busy.has(task.repository) || seen.has(task.repository)) continue;
      seen.add(task.repository);
      void this.exclusive(task.repository, () => this.execute(task.id));
    }
    for (const task of tasks) if (task.status === 'awaiting_review') this.watchReconcile(task.id);
  }

  /** A tick-triggered reconcile at most every few seconds per task; read() and accept() still verify every time. */
  private watchReconcile(id: string): void {
    if (this.reconciles.has(id)) return;
    const last = this.reconciledAt.get(id);
    if (last !== undefined && this.clock() - last < RECONCILE_MIN_INTERVAL) return;
    const run = this.reconcile(id).catch(() => undefined).finally(() => {
      if (this.reconciles.get(id) === run) {
        this.reconciles.delete(id);
        this.reconciledAt.set(id, this.clock());
      }
    });
    this.reconciles.set(id, run);
  }

  private async execute(id: string): Promise<void> {
    if (this.disposed) return;
    let published = false;
    try {
      published = await this.begin(id);
      if (!published || this.disposed) return;
      await this.prepareAndSend(id);
    } catch (error) {
      if (published) await this.failDispatch(id, error).catch(() => undefined);
    }
    if (published) await this.waitUntil(id, task => !isExecution(task.status));
  }

  private async begin(id: string): Promise<boolean> {
    return this.lockTask(id, async () => {
      if (this.disposed) return false;
      const task = this.options.store.tryGet(id);
      if (!task || task.status !== 'queued') return false;
      if (task.collaboration && task.operationId && task.collaborationRunId && task.collaborationControl === 'needs_attention') {
        await this.write({ ...task, status: 'preparing', errorCode: null, errorDetail: null });
        return true;
      }
      const operationId = this.newId();
      await this.write({
        ...task, status: 'preparing', operationId,
        operationIds: [...task.operationIds, operationId].slice(-100),
        agentId: null, workspaceId: null,
        collaborationConversationId: null, collaborationRunId: null,
        collaborationPhase: null, collaborationControl: null, collaborationAcceptance: null,
        review: null, lastOutcome: null, pendingMergeCommit: null, errorCode: null, errorDetail: null,
      });
      return true;
    });
  }

  private async prepareAndSend(id: string): Promise<void> {
    if (this.preparing.has(id)) return;
    this.preparing.add(id);
    const release = this.enter();
    let operationId: string | null = null;
    try {
      if (!release) return;
      const initial = this.options.store.get(id);
      operationId = initial.operationId;
      if (initial.status !== 'preparing' || !operationId) return;
      if (initial.collaboration && initial.collaborationRunId && initial.collaborationControl === 'needs_attention') {
        const port = this.options.collaboration;
        if (!port) throw todoError('collaboration-unavailable');
        const state = await port.control({ id: initial.collaborationRunId, action: 'retry' });
        await this.lockTask(id, () => this.applyCollaboration(id, state));
        return;
      }
      const branch = initial.branch ?? `paseo-todo/${initial.id}`;
      const prepared = await this.gitSerial(initial.repository, () => this.options.git.ensureWorktree({
        root: initial.repository, taskId: initial.id, branch, targetBranch: initial.targetBranch, existingPath: initial.worktree,
      }));
      const located = this.options.store.get(id);
      if (located.operationId !== operationId || located.status !== 'preparing') return;
      await this.write({
        ...located, branch: prepared.branch, worktree: prepared.worktree, baseCommit: prepared.baseCommit, agentId: null, workspaceId: null,
      });
      const fresh = this.options.store.get(id);
      if (fresh.operationId !== operationId || fresh.status !== 'preparing') return;
      if (fresh.collaboration) {
        await this.launchCollaboration(id, operationId);
        const launched = this.options.store.tryGet(id);
        if (launched?.agentId) await this.replay(launched.agentId);
        return;
      }
      const prompt = fresh.pendingPrompt ? followUpPrompt(fresh.prompt, fresh.pendingPrompt) : fresh.prompt;
      const created = await this.options.agents.create({
        operationId, taskId: initial.id, cwd: prepared.worktree, provider: initial.provider,
        modeId: initial.modeId, title: initial.title, prompt, collaboration: fresh.collaboration,
      });
      const after = this.options.store.get(id);
      if (after.operationId !== operationId) return;
      if (after.status === 'canceling') {
        await this.write({ ...after, agentId: created.agentId, workspaceId: created.workspaceId, pendingPrompt: null });
        return;
      }
      if (after.status !== 'preparing') return;
      await this.write({
        ...after, status: 'running', agentId: created.agentId, workspaceId: created.workspaceId,
        pendingPrompt: null, errorCode: null, errorDetail: null,
      });
      await this.replay(created.agentId);
    } finally {
      this.preparing.delete(id);
      try {
        if (operationId) {
          const task = this.options.store.tryGet(id);
          if (task?.status === 'canceling' && task.operationId === operationId) await this.settleCancel(id, operationId, task.agentId);
        }
      } finally {
        release?.();
      }
    }
  }

  private async failDispatch(id: string, error: unknown): Promise<void> {
    const release = this.enter();
    if (!release) return;
    try {
      let replayId: string | null = null;
      await this.lockTask(id, async () => {
        const task = this.options.store.tryGet(id);
        if (!task || !isExecution(task.status)) return;
        if (task.collaboration && task.operationId && this.options.collaboration) {
          // A timed-out open may already have created the host conversation. Collaboration agents
          // do not carry the single-agent operation label, so look up the host's request binding.
          let state: CollaborationState;
          try { state = await this.options.collaboration.status(); }
          catch {
            await this.write({ ...task, errorCode: 'gateway-unavailable', errorDetail: errorText(error).slice(0, 4000) });
            return;
          }
          const conversation = conversationOf(state, task);
          if (conversation?.agentId) {
            await this.write({
              ...task, agentId: conversation.agentId, workspaceId: conversation.workspaceId,
              collaborationConversationId: conversation.id, collaborationRunId: conversation.run?.id ?? null,
              status: task.status === 'canceling' ? 'canceling' : 'running',
            });
            await this.applyCollaboration(id, state);
            return;
          }
          if (state.error) {
            await this.write({ ...task, errorCode: 'gateway-unavailable', errorDetail: state.error.slice(0, 4000) });
            return;
          }
        }
        if (task.operationId) {
          let found: string | null;
          try {
            found = await this.options.agents.findByOperation(task.operationId);
          } catch {
            return;
          }
          if (found) {
            replayId = found;
            await this.write({ ...task, agentId: task.agentId ?? found, status: task.status === 'canceling' ? 'canceling' : 'running' });
            return;
          }
        }
        await this.write({ ...task, status: 'failed', errorCode: failureCode(error) ?? 'prepare-failed', errorDetail: errorText(error).slice(0, 4000) });
      });
      if (replayId) await this.replay(replayId);
    } finally {
      release();
    }
  }

  private async settleCancel(id: string, operationId: string, knownAgent: string | null): Promise<void> {
    const release = this.enter();
    if (!release) return;
    try {
      const task = this.options.store.tryGet(id);
      if (!task || task.status !== 'canceling' || task.operationId !== operationId) return;
      if (task.collaboration) {
        const stopped = await this.cancelCollaborationRun(task);
        if (!stopped) return;
      }
      let agentId = knownAgent ?? task.agentId;
      if (!agentId) {
        try {
          agentId = await this.options.agents.findByOperation(operationId);
        } catch {
          return;
        }
      }
      if (agentId) {
        await this.options.agents.cancel(agentId).catch(() => undefined);
        let snap: AgentInspection;
        try {
          snap = await this.options.agents.inspect(agentId);
        } catch {
          return;
        }
        if (snap.exists && (snap.active || snap.permission)) return;
      }
      await this.lockTask(id, async () => {
        const current = this.options.store.get(id);
        if (current.status !== 'canceling' || current.operationId !== operationId) return;
        const rejected = Boolean(current.collaboration && (current.collaborationAcceptance === 'pending' || current.collaborationPhase === 'awaiting_acceptance'));
        await this.write({
          ...current, agentId: current.agentId ?? agentId, status: 'canceled',
          review: current.collaboration ? null : current.review,
          collaborationAcceptance: current.collaboration ? null : current.collaborationAcceptance,
          errorCode: rejected ? 'collaboration-declined' : 'turn-canceled', errorDetail: null,
        });
      });
      this.tick();
    } finally {
      release();
    }
  }

  private async assertAgentIdle(agentId: string | null): Promise<void> {
    if (!agentId) return;
    let snap: AgentInspection;
    try {
      snap = await this.options.agents.inspect(agentId);
    } catch (error) {
      throw todoError('gateway-unavailable', errorText(error));
    }
    if (snap.exists && (snap.active || snap.permission)) throw todoError('agent-busy');
  }

  private eventKey(event: TurnEvent): string {
    return `${event.agentId}\0${event.turnId ?? ''}\0${event.outcome.kind}`;
  }

  private remember(event: TurnEvent): boolean {
    const key = this.eventKey(event);
    if (this.consumed.has(key)) return false;
    const index = this.turns.findIndex(item => this.eventKey(item) === key);
    if (index >= 0) this.turns.splice(index, 1);
    this.turns.push(event);
    while (this.turns.length > 50) this.turns.shift();
    return true;
  }

  private consume(event: TurnEvent): void {
    this.consumed.add(this.eventKey(event));
    while (this.consumed.size > CONSUMED_LIMIT) this.consumed.delete(this.consumed.values().next().value as string);
    const index = this.turns.findIndex(item => this.eventKey(item) === this.eventKey(event));
    if (index >= 0) this.turns.splice(index, 1);
  }

  private async dispatchTurn(event: TurnEvent): Promise<void> {
    const task = this.options.store.findByAgent(event.agentId);
    if (!task) return;
    if (await this.applyTurn(task.id, event)) this.consume(event);
  }

  private async replay(agentId: string): Promise<void> {
    if (this.permissions.has(agentId)) await this.applyPermission(agentId);
    const pending = this.turns.filter(item => item.agentId === agentId);
    for (const event of pending) {
      if (this.consumed.has(this.eventKey(event))) continue;
      const task = this.options.store.findByAgent(agentId);
      if (!task) continue;
      if (await this.applyTurn(task.id, event)) this.consume(event);
    }
  }

  private async applyTurn(id: string, event: TurnEvent): Promise<boolean> {
    const current = this.options.store.tryGet(id);
    if (current?.collaboration && current.agentId === event.agentId) {
      if (current.status === 'canceling') return true;
      try { await this.syncCollaboration(id, { required: true }); }
      catch { /* a missed poll leaves the run in progress; the next turn or read tries again */ }
      return true;
    }
    const release = this.enter();
    if (!release) return false;
    try {
      let consume = false;
      await this.lockTask(id, async () => {
        const task = this.options.store.get(id);
        if (task.agentId !== event.agentId || !task.operationId) return;
        const started = this.startedTurn.get(event.agentId);
        if (started && event.turnId && started !== event.turnId) {
          consume = true;
          return;
        }
        const outcome = this.outcome(task, event);
        if (event.turnId && task.lastOutcome?.turnId === event.turnId && task.lastOutcome.operationId === task.operationId) {
          consume = true;
          return;
        }
        if ((task.status === 'awaiting_review' || task.status === 'merge_failed') && task.review) {
          if (event.turnId && event.turnId === task.review.turnId) {
            consume = true;
            return;
          }
          await this.write({
            ...task, status: 'needs_check', review: null, lastOutcome: outcome,
            errorCode: 'binding-stale', errorDetail: '会话在绑定之后又结束了一轮',
          });
          consume = true;
          return;
        }
        const next = reduceTurn(task.status, event.outcome.kind);
        if (!next) {
          consume = true;
          return;
        }
        if (next !== 'awaiting_review') {
          await this.write({
            ...task, status: next, lastOutcome: outcome,
            errorCode: next === 'failed' ? 'turn-failed' : 'turn-canceled',
            errorDetail: event.outcome.error?.slice(0, 4000) ?? null,
          });
          consume = true;
          return;
        }
        if (!task.worktree || !task.branch) {
          await this.write({ ...task, status: 'needs_check', lastOutcome: outcome, errorCode: 'capture-failed', errorDetail: null });
          consume = true;
          return;
        }
        try {
          const { worktree, branch } = task;
          const { captured, snap } = await this.gitSerial(task.repository, async () => {
            const captured = await this.options.git.capture({
              root: task.repository, worktree, branch, message: `paseo-todo: capture ${task.id}`,
            });
            const snap = await this.options.git.snapshot({
              root: task.repository, worktree, branch, targetBranch: task.targetBranch,
            });
            return { captured, snap };
          });
          const current = this.options.store.get(id);
          const live = this.startedTurn.get(event.agentId);
          if (
            current.agentId !== event.agentId
            || current.operationId !== task.operationId
            || current.status === 'canceling'
            || !isExecution(current.status)
            || (live && event.turnId && live !== event.turnId)
          ) {
            consume = true;
            return;
          }
          if (!snap.clean || snap.head !== captured.commit || snap.tree !== captured.tree) {
            await this.write({ ...current, status: 'needs_check', lastOutcome: outcome, errorCode: 'capture-failed', errorDetail: '成果提交未能固定' });
            consume = true;
            return;
          }
          await this.write({
            ...current, status: 'awaiting_review', lastOutcome: outcome, errorCode: null, errorDetail: null,
            review: {
              resultCommit: captured.commit, resultTree: captured.tree, targetBranch: task.targetBranch,
              targetHead: snap.targetHead, turnId: event.turnId ?? `operation:${task.operationId}`, operationId: task.operationId,
            },
          });
          consume = true;
        } catch (error) {
          const current = this.options.store.get(id);
          if (!isExecution(current.status) || current.operationId !== task.operationId) {
            consume = true;
            return;
          }
          await this.write({
            ...current, status: 'needs_check', lastOutcome: outcome,
            errorCode: failureCode(error) ?? 'capture-failed', errorDetail: errorText(error).slice(0, 4000),
          });
          consume = true;
        }
      });
      if (!this.disposed) this.tick();
      return consume;
    } finally {
      release();
    }
  }

  private async reconcile(id: string): Promise<void> {
    await this.lockTask(id, async () => {
      const task = this.options.store.tryGet(id);
      if (!task || task.status !== 'awaiting_review' || !task.review || !task.worktree || !task.branch) return;
      try {
        const snap = await this.options.git.snapshot({ root: task.repository, worktree: task.worktree, branch: task.branch, targetBranch: task.targetBranch });
        const review = task.review;
        if (snap.clean && snap.head === review.resultCommit && snap.tree === review.resultTree && snap.targetHead === review.targetHead) return;
        const latest = this.options.store.get(id);
        if (latest.status !== 'awaiting_review') return;
        await this.write({ ...latest, status: 'needs_check', review: null, errorCode: 'binding-stale', errorDetail: '任务成果或目标分支在等待验收时发生了变化' });
      } catch (error) {
        const latest = this.options.store.get(id);
        if (latest.status !== 'awaiting_review') return;
        await this.write({ ...latest, status: 'needs_check', review: null, errorCode: failureCode(error) ?? 'binding-stale', errorDetail: errorText(error).slice(0, 4000) });
      }
    });
  }

  /** A new round keeps the saved snapshot and drops the previous conversation association. */
  private requeue(task: Task, pendingPrompt: string | null): Task {
    return {
      ...task, status: 'queued', pendingPrompt, review: null, lastOutcome: null, pendingMergeCommit: null,
      operationId: null, agentId: null, workspaceId: null, collaborationConversationId: null, collaborationRunId: null,
      collaborationPhase: null, collaborationControl: null, collaborationAcceptance: null, errorCode: null, errorDetail: null,
    };
  }

  private async releaseCollaboration(task: Task): Promise<void> {
    if (!task.collaboration) return;
    if (!this.options.collaboration) throw todoError('collaboration-unavailable');
    const stopped = await this.cancelCollaborationRun(task);
    if (!stopped) throw todoError('gateway-unavailable', '协作还在运行，没有重新启动');
    if (task.agentId) {
      await this.options.agents.cancel(task.agentId).catch(() => undefined);
      await this.assertAgentIdle(task.agentId);
    }
  }

  /** Stops child sessions through the host run. Returns false when the run might still be executing. */
  private async cancelCollaborationRun(task: Task): Promise<boolean> {
    if (!task.collaboration) return true;
    const port = this.options.collaboration;
    if (!port) return false;
    let runId = task.collaborationRunId;
    let unlinkedAgentId: string | null = null;
    if (!runId && (task.collaborationConversationId || task.operationId)) {
      try {
        const state = await port.status();
        if (state.error) return false;
        const conversation = conversationOf(state, task);
        runId = conversation?.run?.id ?? null;
        if (conversation?.agentId && !task.agentId) unlinkedAgentId = conversation.agentId;
      } catch (error) {
        return false;
      }
    }
    try {
      if (runId) {
        let state: CollaborationState;
        try { state = await port.control({ id: runId, action: 'cancel' }); }
        catch {
          // A host rejects cancellation of an already finished run. Read its actual state
          // instead of treating an error containing the word "canceled" as proof.
          state = await port.status();
        }
        if (state.error) return false;
        const run = state.conversations.find(entry => entry.run?.id === runId)?.run;
        if (!run || (run.control !== 'canceled' && run.phase !== 'completed')) return false;
      }
      if (unlinkedAgentId) {
        await this.options.agents.cancel(unlinkedAgentId).catch(() => undefined);
        await this.assertAgentIdle(unlinkedAgentId);
      }
      return true;
    } catch { return false; }
  }

  private async recoverCollaboration(id: string): Promise<void> {
    const task = this.options.store.tryGet(id);
    if (!task?.collaboration || !isExecution(task.status)) return;
    if (!task.operationId) {
      await this.write({ ...task, status: 'needs_check', errorCode: 'needs-check-no-operation', errorDetail: null });
      return;
    }
    if (task.collaborationConversationId && task.agentId && task.worktree) {
      await this.syncCollaboration(id).catch(error => {
        void this.rememberGateway(id, error);
      });
      return;
    }
    try {
      if (!task.worktree || !task.branch) {
        if (task.status !== 'preparing') {
          await this.write({ ...task, status: 'needs_check', errorCode: 'prepare-failed', errorDetail: '任务工作树还没有准备好' });
          return;
        }
        await this.prepareAndSend(id);
        return;
      }
      await this.launchCollaboration(id, task.operationId);
    } catch (error) {
      const current = this.options.store.tryGet(id);
      if (!current || !isExecution(current.status)) return;
      const code = failureCode(error);
      if (!code || code === 'gateway-unavailable') {
        await this.rememberGateway(id, error);
        return;
      }
      await this.write({
        ...current, status: 'failed', errorCode: code, errorDetail: errorText(error).slice(0, 4000),
      });
    }
  }

  private async rememberGateway(id: string, error: unknown): Promise<void> {
    const current = this.options.store.tryGet(id);
    if (!current || !isExecution(current.status)) return;
    await this.write({ ...current, errorCode: 'gateway-unavailable', errorDetail: errorText(error).slice(0, 4000) });
  }

  private watchCollaborations(): void {
    if (this.disposed || this.closed || this.options.store.loadError) return;
    for (const task of this.options.store.list()) {
      if (!task.collaboration) continue;
      if (task.status === 'canceling') {
        if (!this.preparing.has(task.id)) this.watchCollaborationRecovery(task.id);
        continue;
      }
      if (!task.collaborationConversationId) {
        if (!isExecution(task.status) || !task.operationId || this.preparing.has(task.id) || this.collaborationRecoveries.has(task.id)) continue;
        this.watchCollaborationRecovery(task.id);
        continue;
      }
      const review = task.status === 'awaiting_review' || task.status === 'merge_failed';
      const blocked = task.status === 'needs_check' && task.collaborationControl === 'needs_attention';
      if (!isExecution(task.status) && !review && !blocked) continue;
      void this.syncCollaboration(task.id).catch(() => undefined);
    }
  }

  private watchCollaborationRecovery(id: string): void {
    if (this.collaborationRecoveries.has(id)) return;
    const release = this.enter();
    if (!release) return;
    const recovery = this.recoverOne(id).catch(() => undefined).finally(() => {
      this.collaborationRecoveries.delete(id);
      release();
    });
    this.collaborationRecoveries.set(id, recovery);
  }

  private syncCollaboration(id: string, options?: { required?: boolean }): Promise<void> {
    if (this.disposed || this.closed) return Promise.resolve();
    const previous = this.collaborationSyncs.get(id);
    if (previous && !options?.required) return previous;
    // A background sync that just finished does not need to run again; a required one always does.
    if (!options?.required) {
      const last = this.collaborationSyncedAt.get(id);
      if (last !== undefined && this.clock() - last < SYNC_MIN_INTERVAL) return previous ?? Promise.resolve();
    }
    const release = this.enter();
    if (!release) return Promise.resolve();
    const run = (async () => {
      if (previous) await previous.catch(() => undefined);
      await this.syncCollaborationNow(id, options);
    })().finally(() => {
      if (this.collaborationSyncs.get(id) === run) {
        this.collaborationSyncs.delete(id);
        this.collaborationSyncedAt.set(id, this.clock());
      }
      release();
    });
    this.collaborationSyncs.set(id, run);
    return run;
  }

  private async syncCollaborationNow(id: string, options?: { required?: boolean }): Promise<void> {
    const port = this.options.collaboration;
    const task = this.options.store.tryGet(id);
    if (!task?.collaboration) return;
    if (!port || !task.collaborationConversationId) {
      if (options?.required) throw todoError('collaboration-unavailable');
      return;
    }
    if (task.status === 'canceling' || task.status === 'canceled' || task.status === 'merged' || task.status === 'merging' || task.status === 'draft' || task.status === 'queued') return;
    const conversationId = task.collaborationConversationId;
    let state: CollaborationState;
    try {
      // Read-only. The host's `conversation.resync` is the user's redelivery action: it clears the
      // notice key, so polling with it sent the main agent the same status notice every tick.
      state = await port.status();
    } catch (error) {
      if (options?.required) throw todoError('gateway-unavailable', errorText(error));
      return;
    }
    // A retry or continue may have replaced this conversation while the read was in flight.
    await this.lockTask(id, () => {
      const current = this.options.store.tryGet(id);
      if (!current?.collaboration || current.collaborationConversationId !== conversationId) return;
      return this.applyCollaboration(id, state);
    });
  }

  /**
   * Opens the saved snapshot on the task worktree before the host delivers the goal.
   * `conversation.open` is idempotent on `operationId`: the host creates the session, enables
   * collaboration, then delivers the goal, and a repeat open with the same id does not send it again.
   */
  private async launchCollaboration(id: string, operationId: string): Promise<void> {
    const port = this.options.collaboration;
    if (!port) throw todoError('collaboration-unavailable');
    const task = this.options.store.get(id);
    if (!task.collaboration || task.operationId !== operationId) return;
    if (task.status !== 'preparing' && task.status !== 'running' && task.status !== 'needs_attention') return;
    if (task.collaborationConversationId && task.agentId) {
      await this.syncCollaboration(id);
      return;
    }
    if (!task.worktree) throw todoError('prepare-failed', '任务工作树还没有准备好');
    const workspaceId = task.workspaceId ?? await this.options.agents.openWorkspace(task.worktree, task.title);
    const ready = await this.lockTask(id, async () => {
      const located = this.options.store.get(id);
      if (located.operationId !== operationId || (located.status !== 'preparing' && located.status !== 'running' && located.status !== 'needs_attention')) return false;
      if (located.workspaceId !== workspaceId) await this.write({ ...located, workspaceId });
      return true;
    });
    if (!ready) return;
    const current = this.options.store.get(id);
    if (current.operationId !== operationId || !current.collaboration || current.status === 'canceling' || current.status === 'canceled') return;
    const opened = await port.open({
      requestId: operationId,
      workspaceId,
      goal: current.pendingPrompt ? followUpPrompt(current.prompt, current.pendingPrompt) : current.prompt,
      fresh: true,
      collaboration: current.collaboration,
    });
    if (opened.isolation === 'worktree') {
      const runId = opened.runId ?? opened.state.conversations.find(entry => entry.id === opened.conversationId)?.run?.id ?? null;
      if (runId) await port.control({ id: runId, action: 'cancel' }).catch(() => undefined);
      throw todoError('collaboration-unavailable', '协作开了第二份工作树，已取消');
    }
    await this.lockTask(id, async () => {
      const after = this.options.store.get(id);
      if (after.operationId !== operationId) return;
      const linked = {
        ...after,
        agentId: opened.agentId,
        workspaceId: opened.workspaceId || workspaceId,
        collaborationConversationId: opened.conversationId,
        collaborationRunId: opened.runId,
        pendingPrompt: null,
      };
      if (after.status === 'canceling') {
        await this.write(linked);
        return;
      }
      if (after.status !== 'preparing' && after.status !== 'running' && after.status !== 'needs_attention') return;
      await this.write({ ...linked, status: 'running', errorCode: null, errorDetail: null });
      await this.applyCollaboration(id, opened.state);
    });
  }

  private async applyCollaboration(id: string, state: CollaborationState): Promise<void> {
    const task = this.options.store.tryGet(id);
    if (!task?.collaboration) return;
    if (task.status === 'canceling' || task.status === 'canceled' || task.status === 'merged' || task.status === 'merging' || task.status === 'draft' || task.status === 'queued') return;
    const conversation = conversationOf(state, task);
    if (!conversation) {
      // Launch has not stored a conversation yet. An older read must not fail that new operation.
      if (task.collaborationConversationId && (isExecution(task.status) || task.status === 'awaiting_review' || task.status === 'merge_failed')) {
        await this.write({
          ...task, status: 'needs_check', errorCode: 'needs-check-missing-session', errorDetail: null,
        });
      }
      return;
    }
    const view: CollaborationObservation = {
      runId: conversation.run?.id ?? null,
      phase: conversation.run?.phase ?? null,
      control: conversation.run?.control ?? null,
      confirmation: conversation.confirmation?.kind ?? null,
      error: conversation.error ?? state.error,
      message: conversation.run?.message ?? conversation.error ?? null,
    };
    const decision = reduceCollaboration(view);
    await this.applyCollaborationDecision(id, decision);
  }

  private async applyCollaborationDecision(id: string, decision: CollaborationDecision): Promise<void> {
    const task = this.options.store.get(id);
    if (!task.collaboration || task.status === 'canceling' || task.status === 'canceled' || task.status === 'merged' || task.status === 'merging') return;
    if (decision.kind === 'starting') {
      if (task.status === 'awaiting_review' || task.status === 'merge_failed') {
        await this.writeChanged(task, { status: 'needs_check', review: null, collaborationAcceptance: null, errorCode: 'needs-check-no-outcome', errorDetail: '协作会话还没有任务' });
        return;
      }
      if (!isExecution(task.status)) return;
      await this.writeChanged(task, {
        status: 'running', collaborationPhase: null, collaborationControl: null, collaborationAcceptance: null,
        errorCode: collaborationError(task.errorCode) ? null : task.errorCode,
        errorDetail: collaborationError(task.errorCode) ? null : task.errorDetail,
      });
      return;
    }
    if (decision.kind === 'failed') {
      if (!isExecution(task.status)) return;
      await this.writeChanged(task, {
        status: 'failed', errorCode: 'collaboration-unavailable', errorDetail: decision.message.slice(0, 4000) || null,
        collaborationAcceptance: null,
      });
      return;
    }
    if (decision.kind === 'canceled') {
      const rejected = task.collaborationAcceptance === 'pending' || task.collaborationPhase === 'awaiting_acceptance' || decision.phase === 'awaiting_acceptance';
      await this.writeChanged(task, {
        status: 'canceled', review: null, collaborationAcceptance: null,
        collaborationPhase: decision.phase, collaborationControl: decision.control, collaborationRunId: decision.runId ?? task.collaborationRunId,
        errorCode: rejected ? 'collaboration-declined' : 'turn-canceled',
        errorDetail: decision.message.slice(0, 4000) || null,
      });
      return;
    }
    if (decision.kind === 'blocked') {
      await this.writeChanged(task, {
        status: 'needs_check', review: null, collaborationAcceptance: null,
        collaborationPhase: decision.phase || null, collaborationControl: decision.control, collaborationRunId: decision.runId,
        errorCode: 'collaboration-blocked', errorDetail: decision.message.slice(0, 4000) || null,
      });
      return;
    }
    if (decision.kind === 'permission') {
      await this.writeChanged(task, {
        status: 'needs_attention', review: null, lastOutcome: null,
        collaborationPhase: decision.phase, collaborationControl: decision.control, collaborationRunId: decision.runId,
        collaborationAcceptance: null,
        errorCode: collaborationError(task.errorCode) ? null : task.errorCode,
        errorDetail: collaborationError(task.errorCode) ? null : task.errorDetail,
      });
      return;
    }
    if (decision.kind === 'executing') {
      await this.writeChanged(task, {
        status: 'running',
        review: null, lastOutcome: null,
        collaborationPhase: decision.phase, collaborationControl: decision.control, collaborationRunId: decision.runId ?? task.collaborationRunId,
        collaborationAcceptance: null,
        errorCode: null, errorDetail: null,
      });
      return;
    }
    await this.solidifyCollaboration(id, decision);
  }

  private async solidifyCollaboration(id: string, decision: Extract<CollaborationDecision, { kind: 'solidify' }>): Promise<void> {
    const task = this.options.store.get(id);
    if (!task.operationId || !task.worktree || !task.branch) {
      await this.writeChanged(task, { status: 'needs_check', errorCode: 'capture-failed', errorDetail: null, collaborationRunId: decision.runId, collaborationPhase: decision.phase, collaborationControl: decision.control, collaborationAcceptance: decision.acceptance });
      return;
    }
    const turnId = `collaboration:${decision.runId}`;
    const pendingDetail = decision.acceptance === 'pending' ? decision.message.slice(0, 4000) || null : null;
    // A completed run cannot approve later local edits or a changed target. Only observed host rework
    // clears lastOutcome and permits a new capture; a poll must not recreate an invalidated binding.
    if (!task.review && task.lastOutcome?.turnId === turnId && task.lastOutcome.operationId === task.operationId) {
      await this.writeChanged(task, {
        collaborationPhase: decision.phase, collaborationControl: decision.control,
        collaborationRunId: decision.runId, collaborationAcceptance: decision.acceptance,
      });
      return;
    }
    if (task.review && task.review.turnId === turnId && task.review.operationId === task.operationId) {
      await this.writeChanged(task, {
        status: task.status === 'merge_failed' ? 'merge_failed' : 'awaiting_review',
        collaborationPhase: decision.phase, collaborationControl: decision.control, collaborationRunId: decision.runId,
        collaborationAcceptance: decision.acceptance,
        errorCode: decision.acceptance === 'pending' ? 'collaboration-acceptance-pending' : (task.errorCode === 'collaboration-acceptance-pending' ? null : task.errorCode),
        errorDetail: decision.acceptance === 'pending' ? pendingDetail : (task.errorCode === 'collaboration-acceptance-pending' ? null : task.errorDetail),
      });
      return;
    }
    const outcome = this.outcome(task, { agentId: task.agentId ?? '', turnId, outcome: { kind: 'completed' } });
    try {
      const { worktree, branch } = task;
      const { captured, snap } = await this.gitSerial(task.repository, async () => {
        const captured = await this.options.git.capture({
          root: task.repository, worktree, branch, message: `paseo-todo: capture ${task.id}`,
        });
        const snap = await this.options.git.snapshot({
          root: task.repository, worktree, branch, targetBranch: task.targetBranch,
        });
        return { captured, snap };
      });
      const current = this.options.store.get(id);
      if (current.operationId !== task.operationId || current.status === 'canceling' || current.status === 'merged' || current.status === 'merging') return;
      if (!snap.clean || snap.head !== captured.commit || snap.tree !== captured.tree) {
        await this.write({ ...current, status: 'needs_check', lastOutcome: outcome, errorCode: 'capture-failed', errorDetail: '成果提交未能固定', collaborationRunId: decision.runId, collaborationPhase: decision.phase, collaborationControl: decision.control });
        this.tick();
        return;
      }
      await this.write({
        ...current, status: 'awaiting_review', lastOutcome: outcome, collaborationRunId: decision.runId,
        collaborationPhase: decision.phase, collaborationControl: decision.control, collaborationAcceptance: decision.acceptance,
        errorCode: decision.acceptance === 'pending' ? 'collaboration-acceptance-pending' : null,
        errorDetail: pendingDetail,
        review: {
          resultCommit: captured.commit, resultTree: captured.tree, targetBranch: task.targetBranch,
          targetHead: snap.targetHead, turnId, operationId: task.operationId,
        },
      });
      this.tick();
    } catch (error) {
      const current = this.options.store.get(id);
      if (current.operationId !== task.operationId || current.status === 'canceling') return;
      await this.write({
        ...current, status: 'needs_check', errorCode: failureCode(error) ?? 'capture-failed', errorDetail: errorText(error).slice(0, 4000),
        collaborationRunId: decision.runId, collaborationPhase: decision.phase, collaborationControl: decision.control,
      });
      this.tick();
    }
  }

  private async writeChanged(task: Task, patch: Partial<Task>): Promise<void> {
    const next = { ...task, ...patch };
    if (
      next.status === task.status
      && next.collaborationPhase === task.collaborationPhase
      && next.collaborationControl === task.collaborationControl
      && next.collaborationAcceptance === task.collaborationAcceptance
      && next.collaborationRunId === task.collaborationRunId
      && next.errorCode === task.errorCode
      && next.errorDetail === task.errorDetail
      && next.review === task.review
      && next.lastOutcome === task.lastOutcome
      && next.agentId === task.agentId
    ) return;
    await this.write(next);
    if (isExecution(task.status) && !isExecution(next.status)) this.tick();
  }

  private outcome(task: Task, event: TurnEvent): TaskOutcome {
    return {
      kind: event.outcome.kind,
      turnId: event.turnId,
      operationId: task.operationId ?? event.turnId ?? this.newId(),
      at: this.now(),
    };
  }

  private async write(task: Task): Promise<Task> {
    const release = this.enter();
    if (!release) return this.options.store.tryGet(task.id) ?? task;
    try {
      const next = await this.options.store.replace({ ...task, updatedAt: this.now() });
      // A terminal task's session gets no more turns for it, so its turn/permission bookkeeping can go,
      // along with the per-task throttle and reconcile entries. taskTails stays: a queued lock could still
      // be chained on it, and dropping the tail would let a new lock run concurrently.
      if (next.status === 'merged' || next.status === 'canceled') {
        if (next.agentId) {
          this.startedTurn.delete(next.agentId);
          this.permissions.delete(next.agentId);
        }
        this.collaborationSyncedAt.delete(next.id);
        this.reconciledAt.delete(next.id);
        this.reconciles.delete(next.id);
      }
      for (const listener of [...this.listeners]) listener();
      return next;
    } finally {
      release();
    }
  }

  private enter(): (() => void) | null {
    if (this.closed) return null;
    if (this.draining && this.spanDepth === 0) return null;
    this.spanDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.spanDepth -= 1;
      if (this.spanDepth === 0) {
        const waiters = this.idleWaiters.splice(0);
        for (const waiter of waiters) waiter();
      }
    };
  }

  private whenIdle(): Promise<void> {
    if (this.spanDepth === 0) return Promise.resolve();
    return new Promise(resolve => { this.idleWaiters.push(resolve); });
  }

  private waitUntil(id: string, pred: (task: Task) => boolean): Promise<void> {
    const ready = () => {
      const task = this.options.store.tryGet(id);
      return this.disposed || !task || pred(task);
    };
    if (ready()) return Promise.resolve();
    return new Promise(resolve => {
      const listener = () => {
        if (!ready()) return;
        this.listeners.delete(listener);
        resolve();
      };
      this.listeners.add(listener);
      if (ready()) listener();
    });
  }

  private exclusive<T>(repository: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.repoTails.get(repository) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.repoTails.set(repository, run.then(() => undefined, () => undefined));
    return run;
  }

  /** Short per-repository lock for git writes: worktree setup, capture and merge. Always taken inside a task lock, never the reverse. */
  private gitSerial<T>(repository: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.gitTails.get(repository) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.gitTails.set(repository, run.then(() => undefined, () => undefined));
    return run;
  }

  private lockTask<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.taskTails.get(id) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.taskTails.set(id, previous.then(() => gate, () => gate));
    return previous.then(async () => {
      try { return await fn(); }
      finally { release(); }
    }, async () => {
      try { return await fn(); }
      finally { release(); }
    });
  }
}
