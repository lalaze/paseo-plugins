import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { todoError, type TodoErrorCode, type TodoFailure } from '../shared/errors';
import { canAccept, canCancel, canContinue, canEnqueue, canRetry, isExecution, recoverExecution, reducePermission, reduceTurn, type TurnKind } from '../shared/machine';
import { reviewBindingSchema, reviewsMatch, taskSchema, type ReviewBinding, type Task, type TaskDiff, type TaskOutcome } from '../shared/schema';
import type { AgentInspection, AgentPort } from './agents';
import type { GitPort } from './git';
import type { TaskStore } from './store';

const EMPTY_DIFF: TaskDiff = { patch: '', files: [], truncated: false };

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
}

export interface TodoEngineOptions {
  store: TaskStore;
  git: GitPort;
  agents: AgentPort;
  now?: () => number;
  newId?: () => string;
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

function mergeError(reason: string): TodoErrorCode {
  if (reason === 'conflict') return 'merge-conflict';
  if (reason === 'dirty') return 'merge-dirty';
  if (reason === 'stale-target' || reason === 'stale-result') return 'binding-stale';
  return 'merge-verify';
}

export class TodoEngine {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly listeners = new Set<() => void>();
  private readonly repoTails = new Map<string, Promise<void>>();
  private readonly gitTails = new Map<string, Promise<void>>();
  private readonly taskTails = new Map<string, Promise<void>>();
  private readonly turns: TurnEvent[] = [];
  private readonly consumed = new Set<string>();
  private readonly startedTurn = new Map<string, string | null>();
  private readonly permissions = new Map<string, Set<string>>();
  private readonly preparing = new Set<string>();
  private readonly idleWaiters: Array<() => void> = [];
  private spanDepth = 0;
  private draining = false;
  private disposed = false;
  private closed = false;

  constructor(private readonly options: TodoEngineOptions) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => randomUUID());
  }

  list() {
    return { tasks: this.options.store.list(), loadError: this.options.store.loadError, dataDir: this.options.store.dir };
  }

  /** Tasks store the resolved repository root, so a workspace path is resolved the same way before comparing. */
  async listIn(path: string) {
    const repository = await this.options.git.resolveRepository(path);
    const listed = this.list();
    return { ...listed, tasks: listed.tasks.filter(task => task.repository === repository) };
  }

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
      provider: input.provider, modeId: input.modeId, status: 'draft', branch: null, worktree: null,
      baseCommit: null, agentId: null, workspaceId: null, operationId: null, operationIds: [],
      review: null, lastOutcome: null, pendingMergeCommit: null, mergeCommit: null, mergeMethod: null,
      errorCode: null, errorDetail: null, createdAt: now, updatedAt: now,
    });
    await this.options.store.insert(task);
    return task;
  }

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

  async read(id: string): Promise<{ task: Task; diff: TaskDiff }> {
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

  async cancel(id: string): Promise<Task> {
    if (this.disposed) throw todoError('cancel-rejected');
    let agentId: string | null = null;
    let operationId: string | null = null;
    let execution = false;
    await this.lockTask(id, async () => {
      const task = this.options.store.get(id);
      if (task.status === 'merging' || task.status === 'canceling' || !canCancel(task.status)) throw todoError('cancel-rejected');
      if (!isExecution(task.status)) {
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

  async retry(id: string): Promise<Task> {
    await this.lockTask(id, async () => {
      const task = this.options.store.get(id);
      if (!canRetry(task.status)) throw todoError('retry-rejected');
      await this.write({
        ...task, status: 'queued', pendingPrompt: null, review: null, lastOutcome: null,
        pendingMergeCommit: null, operationId: null, agentId: null, workspaceId: null,
        errorCode: null, errorDetail: null,
      });
    });
    this.tick();
    return this.options.store.get(id);
  }

  async continue(id: string, prompt: string): Promise<Task> {
    const pendingPrompt = prompt.trim();
    if (!pendingPrompt) throw todoError('empty-prompt');
    await this.lockTask(id, async () => {
      const task = this.options.store.get(id);
      if (!canContinue(task.status)) throw todoError('continue-rejected');
      await this.write({
        ...task, status: 'queued', pendingPrompt, review: null, lastOutcome: null,
        pendingMergeCommit: null, operationId: null, agentId: null, workspaceId: null,
        errorCode: null, errorDetail: null,
      });
    });
    this.tick();
    return this.options.store.get(id);
  }

  /** Merge is reachable only from this method, and only after the displayed binding matches the saved one. */
  async accept(id: string, review: ReviewBinding): Promise<Task> {
    if (this.disposed) throw todoError('accept-rejected');
    const task = this.options.store.get(id);
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

  async onTurnStarted(event: TurnStartedEvent): Promise<void> {
    if (this.disposed) return;
    this.startedTurn.set(event.agentId, event.turnId);
    const task = this.options.store.list().find(item => item.agentId === event.agentId);
    if (!task) return;
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

  async onTurnEnded(event: TurnEvent): Promise<void> {
    if (this.disposed) return;
    if (!this.remember(event)) return;
    await this.dispatchTurn(event);
  }

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
    const task = this.options.store.list().find(item => item.agentId === agentId);
    if (!task) return;
    await this.lockTask(task.id, async () => {
      const current = this.options.store.get(task.id);
      const next = reducePermission(current.status, pending);
      if (next !== current.status) await this.write({ ...current, status: next });
    });
    if (!pending) this.permissions.delete(agentId);
  }

  async recover(): Promise<void> {
    if (this.options.store.loadError) return;
    for (const task of this.options.store.list()) await this.recoverOne(task.id);
    for (const task of this.options.store.list()) {
      if (isExecution(task.status)) void this.exclusive(task.repository, () => this.waitUntil(task.id, item => !isExecution(item.status)));
    }
    this.tick();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
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
    if (!reviewsMatch(task.review, displayed)) throw todoError('stale-client-review');
    const started = task.agentId ? this.startedTurn.get(task.agentId) : undefined;
    if (started && started !== task.review.turnId) throw todoError('agent-busy');
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
    for (const task of tasks) if (task.status === 'awaiting_review') void this.reconcile(task.id);
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
      const operationId = this.newId();
      await this.write({
        ...task, status: 'preparing', operationId,
        operationIds: [...task.operationIds, operationId].slice(-100),
        agentId: null, workspaceId: null,
        review: null, lastOutcome: null, pendingMergeCommit: null, errorCode: null, errorDetail: null,
      });
      return true;
    });
  }

  private async prepareAndSend(id: string): Promise<void> {
    this.preparing.add(id);
    const release = this.enter();
    let operationId: string | null = null;
    try {
      if (!release) return;
      const initial = this.options.store.get(id);
      operationId = initial.operationId;
      if (initial.status !== 'preparing' || !operationId) return;
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
      const prompt = fresh.pendingPrompt ? followUpPrompt(fresh.prompt, fresh.pendingPrompt) : fresh.prompt;
      const created = await this.options.agents.create({
        operationId, taskId: initial.id, cwd: prepared.worktree, provider: initial.provider,
        modeId: initial.modeId, title: initial.title, prompt,
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
        await this.write({
          ...current, agentId: current.agentId ?? agentId, status: 'canceled', errorCode: 'turn-canceled', errorDetail: null,
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
    const index = this.turns.findIndex(item => this.eventKey(item) === this.eventKey(event));
    if (index >= 0) this.turns.splice(index, 1);
  }

  private async dispatchTurn(event: TurnEvent): Promise<void> {
    const task = this.options.store.list().find(item => item.agentId === event.agentId);
    if (!task) return;
    if (await this.applyTurn(task.id, event)) this.consume(event);
  }

  private async replay(agentId: string): Promise<void> {
    if (this.permissions.has(agentId)) await this.applyPermission(agentId);
    const pending = this.turns.filter(item => item.agentId === agentId);
    for (const event of pending) {
      if (this.consumed.has(this.eventKey(event))) continue;
      const task = this.options.store.list().find(item => item.agentId === agentId);
      if (!task) continue;
      if (await this.applyTurn(task.id, event)) this.consume(event);
    }
  }

  private async applyTurn(id: string, event: TurnEvent): Promise<boolean> {
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
      const next = taskSchema.parse({ ...task, updatedAt: this.now() });
      await this.options.store.replace(next);
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
