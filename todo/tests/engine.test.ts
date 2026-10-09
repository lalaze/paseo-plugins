import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AgentInspection, AgentPort } from '../server/agents';
import { CollaborationWire, PaseoCollaborationPort, type CollaborationPort, type OpenedCollaboration } from '../server/collaboration';
import { TodoEngine, type TurnEvent } from '../server/engine';
import type { GitPort, PrepareOk } from '../server/git';
import { TaskStore } from '../server/store';
import { taskCollaborationSchema, type CollaborationState, type TaskCollaboration } from '../shared/collaboration';
import { todoError } from '../shared/errors';
import type { ReviewBinding, Task } from '../shared/schema';

const H = '11'.repeat(20);
const R = '22'.repeat(20);
const T = '33'.repeat(20);
const M = '44'.repeat(20);
const B = '55'.repeat(20);
const OTHER = '66'.repeat(20);
const REPO = '/tmp/paseo-todo-repo';

function idle(): AgentInspection {
  return { exists: true, active: false, permission: false, status: 'idle' };
}

function reviewOf(task: Task): ReviewBinding {
  assert.ok(task.review);
  return task.review;
}

async function waitFor(pred: () => boolean, timeoutMs = 400): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
}

function harness(options: {
  inspect?: () => Promise<AgentInspection>;
  find?: (operationId: string) => Promise<string | null>;
  ensure?: GitPort['ensureWorktree'];
  capture?: GitPort['capture'];
  prepare?: GitPort['prepareMerge'];
  resolve?: GitPort['resolveRepository'];
  apply?: GitPort['applyMerge'];
  target?: () => Promise<string>;
  cancel?: (agentId: string) => Promise<void>;
  archive?: () => Promise<void>;
  removeWorktree?: GitPort['removeWorktree'];
  collaboration?: CollaborationPort;
  clock?: () => number;
  startedTurnLimit?: number;
} = {}) {
  const archived: Array<{ taskId: string; workspaceId: string | null; worktree: string | null }> = [];
  const removed: string[] = [];
  const deleted: Array<{ branch: string; expectedHead: string; targetBranch: string }> = [];
  const created: string[] = [];
  const workspaces: string[] = [];
  const workspaceTitles: Array<string | undefined> = [];
  const prompts: string[] = [];
  const cancels: string[] = [];
  const sent: string[] = [];
  const captures: string[] = [];
  const prepares: number[] = [];
  let seq = 0;
  const agents: AgentPort = {
    async create(input) {
      const agentId = `agent-${input.operationId}`;
      created.push(agentId);
      prompts.push(input.prompt);
      return { agentId, workspaceId: 'ws-1' };
    },
    async openWorkspace(cwd: string, title?: string) { workspaces.push(cwd); workspaceTitles.push(title); return 'ws-1'; },
    async send(input) {
      sent.push(input.agentId);
    },
    async cancel(agentId) { cancels.push(agentId); await options.cancel?.(agentId); },
    inspect: options.inspect ?? (async () => idle()),
    findByOperation: options.find ?? (async () => null),
    async archiveTask(input) { await options.archive?.(); archived.push(input); },
  };
  const prepared = (input: Parameters<GitPort['prepareMerge']>[0]): PrepareOk => ({
    ok: true, mergeCommit: M, checkout: null, root: input.root, worktree: input.worktree,
    taskBranch: input.taskBranch, targetBranch: input.targetBranch, expectedTargetHead: input.expectedTargetHead,
    resultCommit: input.resultCommit, resultTree: input.resultTree,
  });
  const git: GitPort = {
    resolveRepository: options.resolve ?? (async path => path),
    async listBranches() { return { branches: ['main'], head: 'main' }; },
    async branchExists() { return true; },
    ensureWorktree: options.ensure ?? (async input => ({ worktree: `/wt/${input.taskId}`, branch: input.branch, baseCommit: B })),
    capture: options.capture ?? (async input => { captures.push(input.branch); return { commit: R, tree: T }; }),
    async snapshot() { return { head: R, tree: T, clean: true, targetHead: H }; },
    readTargetHead: options.target ?? (async () => H),
    async diff() { return { patch: '', files: [], truncated: false }; },
    prepareMerge: options.prepare ?? (async input => { prepares.push(1); return prepared(input); }),
    applyMerge: options.apply ?? (async input => ({ ok: true, mergeCommit: input.mergeCommit, method: 'update-ref' })),
    async removeWorktree(input) { await options.removeWorktree?.(input); removed.push(input.worktree); },
    async deleteMergedBranch(input) { deleted.push({ branch: input.branch, expectedHead: input.expectedHead, targetBranch: input.targetBranch }); },
  };
  let now = 1;
  return {
    created, sent, captures, prepares, prompts, cancels, archived, removed, deleted, workspaces, workspaceTitles, agents, git,
    engine: null as unknown as TodoEngine,
    async open(dir: string) {
      const store = await TaskStore.open(dir);
      const engine = new TodoEngine({
        store, git, agents, ...(options.collaboration ? { collaboration: options.collaboration } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.startedTurnLimit ? { startedTurnLimit: options.startedTurnLimit } : {}),
        now: () => now++, newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      });
      this.engine = engine;
      return engine;
    },
  };
}

/** Writes a task straight to disk, as a previous process would have left it. */
async function seed(dir: string, patch: Partial<Task>): Promise<Task> {
  const store = await TaskStore.open(dir);
  const task: Task = {
    id: '00000000-0000-4000-8000-00000000abcd', title: 'seeded', prompt: 'do seeded', pendingPrompt: null, repository: REPO,
    projectId: null, projectName: null, targetBranch: 'main', provider: 'stub/model', modeId: null, status: 'running',
    branch: 'paseo-todo/seeded', worktree: '/wt/seeded', baseCommit: B, agentId: 'agent-seeded', workspaceId: 'ws-1',
    operationId: '00000000-0000-4000-8000-00000000beef', operationIds: ['00000000-0000-4000-8000-00000000beef'],
    collaboration: null, collaborationConversationId: null, collaborationRunId: null, review: null,
    lastOutcome: null, pendingMergeCommit: null, mergeCommit: null, mergeMethod: null, errorCode: null, errorDetail: null,
    cleanup: null, createdAt: 1, updatedAt: 1, ...patch,
  } as Task;
  await store.insert(task);
  await store.dispose();
  return task;
}

/** Runs a task through one completed turn so it waits for review. */
async function reviewed(box: ReturnType<typeof harness>, engine: TodoEngine, title: string): Promise<Task> {
  const task = await draft(engine, title);
  await engine.startTask(task.id);
  await waitFor(() => engine.list().tasks.find(item => item.id === task.id)?.status === 'running');
  const agentId = engine.list().tasks.find(item => item.id === task.id)?.agentId ?? '';
  await engine.onTurnEnded({ agentId, turnId: `turn-${title}`, outcome: { kind: 'completed' } });
  const done = engine.list().tasks.find(item => item.id === task.id);
  assert.equal(done?.status, 'awaiting_review');
  return done as Task;
}

async function draft(engine: TodoEngine, title: string): Promise<Task> {
  return engine.createTask({
    title, prompt: `do ${title}`, repository: REPO, projectId: null, projectName: null,
    targetBranch: 'main', provider: 'stub/model', modeId: null,
  });
}

describe('engine rounds', () => {
  it('keeps an old completed turn from capturing the next operation', async () => {
    const box = harness();
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      const task = await draft(engine, 'copy');
      await engine.startQueue(null);
      await waitFor(() => box.created.length === 1 && engine.list().tasks[0]?.status === 'running');
      const firstAgent = box.created[0];
      const first = engine.list().tasks[0];
      assert.ok(first);
      await engine.onTurnStarted({ agentId: firstAgent, turnId: 'turn-1' });
      await engine.onTurnEnded({ agentId: firstAgent, turnId: 'turn-1', outcome: { kind: 'completed' } });
      assert.equal(box.captures.length, 1);
      assert.equal(engine.list().tasks[0]?.status, 'awaiting_review');
      const firstOperation = engine.list().tasks[0]?.operationId;

      await engine.continue(task.id, 'change the headline');
      await waitFor(() => engine.list().tasks[0]?.status === 'running' && box.created.length === 2);
      const second = engine.list().tasks[0];
      assert.ok(second);
      assert.notEqual(second.operationId, firstOperation);
      assert.equal(second.review, null);
      assert.equal(box.sent.length, 0);
      assert.notEqual(box.created[1], firstAgent);

      const old: TurnEvent = { agentId: firstAgent, turnId: 'turn-1', outcome: { kind: 'completed' } };
      await engine.onTurnEnded(old);
      await engine.onTurnEnded(old);
      assert.equal(box.captures.length, 1);
      assert.equal(box.prepares.length, 0);
      assert.equal(engine.list().tasks[0]?.status, 'running');
      assert.equal(engine.list().tasks[0]?.operationId, second.operationId);
      assert.equal(engine.list().tasks[0]?.review, null);
      await engine.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies a completion that arrives before the agent id is saved, once', async () => {
    const box = harness();
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      const original = box.agents.create;
      box.agents.create = async input => {
        const created = await original(input);
        await engine.onTurnStarted({ agentId: created.agentId, turnId: 'early' });
        await engine.onTurnEnded({ agentId: created.agentId, turnId: 'early', outcome: { kind: 'completed' } });
        return created;
      };
      await draft(engine, 'early');
      await engine.startQueue(null);
      await waitFor(() => engine.list().tasks[0]?.status === 'awaiting_review');
      assert.equal(box.captures.length, 1);
      await engine.onTurnEnded({ agentId: box.created[0] ?? '', turnId: 'early', outcome: { kind: 'completed' } });
      assert.equal(box.captures.length, 1);
      assert.equal(box.prepares.length, 0);
      await engine.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a stale displayed review and then merges the current one', async () => {
    const box = harness();
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      const task = await draft(engine, 'review');
      await engine.startQueue(null);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      await engine.onTurnEnded({ agentId: box.created[0] ?? '', turnId: 'turn-1', outcome: { kind: 'completed' } });
      const saved = reviewOf(engine.list().tasks[0] as Task);
      const stale = { ...saved, resultCommit: OTHER };
      await assert.rejects(() => engine.accept(task.id, stale), /stale-client-review/);
      assert.equal(box.prepares.length, 0);
      assert.equal(engine.list().tasks[0]?.status, 'awaiting_review');
      assert.deepEqual(engine.list().tasks[0]?.review, saved);
      const merged = await engine.accept(task.id, saved);
      assert.equal(merged.status, 'merged');
      assert.equal(box.prepares.length, 1);
      await engine.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses accept while the session is active, waiting for permission, or unreachable', async () => {
    for (const inspect of [
      async () => ({ exists: true, active: true, permission: false, status: 'running' }),
      async () => ({ exists: true, active: false, permission: true, status: 'idle' }),
      async () => { throw new Error('down'); },
    ]) {
      const box = harness({ inspect });
      const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
      try {
        const engine = await box.open(dir);
        const task = await draft(engine, 'busy');
        await engine.startQueue(null);
        await waitFor(() => engine.list().tasks[0]?.status === 'running');
        await engine.onTurnEnded({ agentId: box.created[0] ?? '', turnId: 'turn-1', outcome: { kind: 'completed' } });
        const saved = reviewOf(engine.list().tasks[0] as Task);
        await assert.rejects(() => engine.accept(task.id, saved), /agent-busy|gateway-unavailable/);
        assert.equal(box.prepares.length, 0);
        assert.equal(engine.list().tasks[0]?.status, 'awaiting_review');
        assert.deepEqual(engine.list().tasks[0]?.review, saved);
        await engine.dispose();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('drops the saved review when a new turn starts before any file change', async () => {
    const box = harness();
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      const task = await draft(engine, 'follow');
      await engine.startQueue(null);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      await engine.onTurnStarted({ agentId: box.created[0] ?? '', turnId: 'turn-1' });
      await engine.onTurnEnded({ agentId: box.created[0] ?? '', turnId: 'turn-1', outcome: { kind: 'completed' } });
      const saved = reviewOf(engine.list().tasks[0] as Task);
      await engine.onTurnStarted({ agentId: box.created[0] ?? '', turnId: 'turn-2' });
      assert.equal(engine.list().tasks[0]?.status, 'needs_check');
      assert.equal(engine.list().tasks[0]?.review, null);
      await assert.rejects(() => engine.accept(task.id, saved), /accept-rejected|agent-busy|stale-client-review/);
      assert.equal(box.prepares.length, 0);
      assert.equal(engine.list().tasks[0]?.review, null);
      await engine.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('coalesces tick reconciles for a task awaiting review, but read still checks every time', async () => {
    let tick = 0;
    const box = harness({ clock: () => tick });
    let snapshots = 0;
    const snap = box.git.snapshot;
    box.git.snapshot = async input => { snapshots += 1; return snap(input); };
    await withEngine(box, async engine => {
      const task = await reviewed(box, engine, 'calm');
      await new Promise(resolve => setTimeout(resolve, 20));
      const calm = snapshots;
      // More ticks inside the window do not re-snapshot the same task.
      await engine.startQueue(null);
      await engine.startQueue(null);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(snapshots, calm);
      // A read reconciles regardless of the window.
      await engine.read(task.id);
      assert.equal(snapshots, calm + 1);
      // Past the window, a tick reconciles again.
      tick += 6000;
      await engine.startQueue(null);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(snapshots, calm + 2);
    });
  });

  it('evicts the longest-idle agent from the turn ledger, not one that keeps starting turns', async () => {
    const box = harness({ startedTurnLimit: 2 });
    await withEngine(box, async engine => {
      const task = await draft(engine, 'busy');
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      const agentId = box.created[0] ?? '';
      await engine.onTurnStarted({ agentId, turnId: 't1' });
      await engine.onTurnStarted({ agentId: 'idle-1', turnId: 'x1' });
      // Refreshing the live agent moves it to the back; the overflow then drops idle-1, never it.
      await engine.onTurnStarted({ agentId, turnId: 't2' });
      await engine.onTurnStarted({ agentId: 'idle-2', turnId: 'x2' });
      // The live entry still says t2: a stale end from t1 is consumed without capturing.
      await engine.onTurnEnded({ agentId, turnId: 't1', outcome: { kind: 'completed' } });
      assert.equal(engine.list().tasks[0]?.status, 'running');
      assert.equal(box.captures.length, 0);
      await engine.onTurnEnded({ agentId, turnId: 't2', outcome: { kind: 'completed' } });
      assert.equal(engine.list().tasks[0]?.status, 'awaiting_review');
      assert.equal(box.captures.length, 1);
    });
  });

  it('finishes a cancel that arrives during worktree setup when no agent exists', async () => {
    let releaseEnsure: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { releaseEnsure = resolve; });
    const box = harness({
      ensure: async input => {
        entered();
        await gate;
        return { worktree: `/wt/${input.taskId}`, branch: input.branch, baseCommit: B };
      },
    });
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      const first = await draft(engine, 'one');
      await draft(engine, 'two');
      await engine.startQueue(null);
      await enteredPromise;
      await engine.cancel(first.id);
      assert.equal(box.created.length, 0);
      releaseEnsure();
      await waitFor(() => engine.list().tasks.some(task => task.status === 'canceled'));
      await waitFor(() => engine.list().tasks.some(task => task.title === 'two' && task.status === 'running'));
      assert.equal(box.created.length, 1);
      assert.equal(engine.list().tasks.find(task => task.id === first.id)?.status, 'canceled');
      await engine.dispose();
    } finally {
      releaseEnsure();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not treat an inspect failure as a stopped agent', async () => {
    let releaseEnsure: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { releaseEnsure = resolve; });
    let finds = 0;
    const box = harness({
      ensure: async input => {
        entered();
        await gate;
        return { worktree: `/wt/${input.taskId}`, branch: input.branch, baseCommit: B };
      },
      find: async () => {
        finds += 1;
        throw new Error('down');
      },
    });
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      const first = await draft(engine, 'one');
      const second = await draft(engine, 'two');
      await engine.startQueue(null);
      await enteredPromise;
      await engine.cancel(first.id);
      releaseEnsure();
      await waitFor(() => finds > 0);
      assert.equal(engine.list().tasks.find(task => task.id === first.id)?.status, 'canceling');
      assert.equal(engine.list().tasks.find(task => task.id === second.id)?.status, 'queued');
      assert.equal(box.created.length, 0);
      await engine.dispose();
    } finally {
      releaseEnsure();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('waits for an in-flight capture before releasing the store lock and does not dispatch after close', async () => {
    let releaseCapture: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { releaseCapture = resolve; });
    const box = harness({
      capture: async () => {
        entered();
        await gate;
        return { commit: R, tree: T };
      },
    });
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      await draft(engine, 'hold');
      await engine.startQueue(null);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      const ending = engine.onTurnEnded({ agentId: box.created[0] ?? '', turnId: 'turn-1', outcome: { kind: 'completed' } });
      await enteredPromise;
      let disposed = false;
      const disposing = engine.dispose().then(() => { disposed = true; });
      const blocked = await TaskStore.open(dir);
      assert.equal(blocked.loadError, 'store-locked');
      await blocked.dispose();
      const still = await TaskStore.open(dir);
      assert.equal(still.loadError, 'store-locked');
      assert.equal(disposed, false);
      releaseCapture();
      await ending;
      await disposing;
      const reopened = await TaskStore.open(dir);
      assert.equal(reopened.loadError, null);
      assert.equal(reopened.list()[0]?.status, 'awaiting_review');
      await reopened.dispose();
      await assert.rejects(() => engine.startQueue(null), /store-invalid/);
      assert.equal(box.created.length, 1);
    } finally {
      releaseCapture();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not send a saved operation again after restart', async () => {
    const box = harness({ inspect: async () => ({ exists: true, active: false, permission: false, status: 'idle' }) });
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      await draft(engine, 'restart');
      await engine.startQueue(null);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      const operationId = engine.list().tasks[0]?.operationId;
      await engine.dispose();
      const store = await TaskStore.open(dir);
      const again = new TodoEngine({
        store, git: box.git, agents: box.agents, now: () => 10, newId: () => '00000000-0000-4000-8000-000000000099',
      });
      await again.recover();
      assert.equal(box.created.length, 1);
      assert.equal(again.list().tasks[0]?.status, 'needs_check');
      assert.equal(again.list().tasks[0]?.operationId, operationId);
      await again.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs one task per repository and rejects cancel during merge', async () => {
    let releaseMerge: () => void = () => undefined;
    let mergeEntered: () => void = () => undefined;
    const mergeReady = new Promise<void>(resolve => { mergeEntered = resolve; });
    const gate = new Promise<void>(resolve => { releaseMerge = resolve; });
    const box = harness({
      prepare: async input => {
        mergeEntered();
        await gate;
        return {
          ok: true, mergeCommit: M, checkout: null, root: input.root, worktree: input.worktree,
          taskBranch: input.taskBranch, targetBranch: input.targetBranch, expectedTargetHead: input.expectedTargetHead,
          resultCommit: input.resultCommit, resultTree: input.resultTree,
        };
      },
    });
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      const first = await draft(engine, 'first');
      const second = await draft(engine, 'second');
      await engine.startQueue(null);
      await waitFor(() => engine.list().tasks.filter(task => task.status === 'running').length === 1);
      assert.equal(engine.list().tasks.find(task => task.id === second.id)?.status, 'queued');
      assert.equal(box.created.length, 1);
      await engine.onTurnEnded({ agentId: box.created[0] ?? '', turnId: 'turn-1', outcome: { kind: 'failed', error: 'nope' } });
      assert.equal(box.captures.length, 0);
      assert.equal(box.prepares.length, 0);
      await waitFor(() => engine.list().tasks.find(task => task.id === second.id)?.status === 'running');
      await engine.onTurnEnded({ agentId: box.created[1] ?? '', turnId: 'turn-2', outcome: { kind: 'completed' } });
      const saved = reviewOf(engine.list().tasks.find(task => task.id === second.id) as Task);
      const accepting = engine.accept(second.id, saved);
      await mergeReady;
      const canceling = engine.cancel(second.id);
      releaseMerge();
      await assert.rejects(canceling, /cancel-rejected/);
      assert.equal((await accepting).status, 'merged');
      assert.equal(engine.list().tasks.find(task => task.id === first.id)?.status, 'failed');
      await engine.dispose();
    } finally {
      releaseMerge();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scopes the queue and the list to the repository a subdirectory resolves to', async () => {
    const OTHER_REPO = '/tmp/paseo-todo-other';
    const box = harness({ resolve: async path => (path.startsWith(`${REPO}/`) ? REPO : path) });
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      const mine = await draft(engine, 'mine');
      const other = await engine.createTask({
        title: 'other', prompt: 'do other', repository: OTHER_REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null,
      });
      assert.deepEqual((await engine.listIn(`${REPO}/packages/app`)).tasks.map(task => task.id), [mine.id]);
      await engine.startQueue(`${REPO}/packages/app`);
      await waitFor(() => engine.list().tasks.find(task => task.id === mine.id)?.status === 'running');
      assert.equal(engine.list().tasks.find(task => task.id === other.id)?.status, 'draft');
      assert.equal(box.created.length, 1);
      await engine.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts one draft without queueing the other drafts in its repository', async () => {
    const box = harness();
    const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
    try {
      const engine = await box.open(dir);
      const first = await draft(engine, 'first');
      const second = await draft(engine, 'second');
      await engine.startTask(second.id);
      await waitFor(() => engine.list().tasks.find(task => task.id === second.id)?.status === 'running');
      assert.equal(engine.list().tasks.find(task => task.id === first.id)?.status, 'draft');
      assert.equal(box.created.length, 1);
      await assert.rejects(engine.startTask(second.id), /start-rejected/);
      await engine.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function withEngine(box: ReturnType<typeof harness>, fn: (engine: TodoEngine, dir: string) => Promise<void>, before?: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'todo-engine-'));
  try {
    await before?.(dir);
    const engine = await box.open(dir);
    try { await fn(engine, dir); } finally { await engine.dispose(); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const statusOf = (engine: TodoEngine, id: string) => engine.list().tasks.find(task => task.id === id)?.status;

describe('engine failure paths', () => {
  it('does not leave a task in merging when git throws, and frees the repository', async () => {
    const box = harness({ prepare: async () => { throw new Error('git worktree list timed out'); } });
    await withEngine(box, async engine => {
      const task = await reviewed(box, engine, 'boom');
      const next = await draft(engine, 'next');
      const result = await engine.accept(task.id, reviewOf(task));
      assert.equal(result.status, 'merge_failed');
      assert.match(result.errorDetail ?? '', /timed out/);
      assert.ok(result.review, 'the binding stays so accept can be tried again');
      await engine.startTask(next.id);
      await waitFor(() => statusOf(engine, next.id) === 'running');
    });
  });

  it('settles a merge that threw after the ref moved from the target ref, not from the exception', async () => {
    const moved = harness({ apply: async () => { throw new Error('rev-parse failed'); }, target: async () => M });
    await withEngine(moved, async engine => {
      const task = await reviewed(moved, engine, 'moved');
      const result = await engine.accept(task.id, reviewOf(task));
      assert.equal(result.status, 'merged');
      assert.equal(result.mergeCommit, M);
    });
    const unmoved = harness({ apply: async () => { throw new Error('rev-parse failed'); } });
    await withEngine(unmoved, async engine => {
      const task = await reviewed(unmoved, engine, 'unmoved');
      assert.equal((await engine.accept(task.id, reviewOf(task))).status, 'merge_failed');
    });
    const unreadable = harness({ apply: async () => { throw new Error('rev-parse failed'); }, target: async () => { throw new Error('no repo'); } });
    await withEngine(unreadable, async engine => {
      const task = await reviewed(unreadable, engine, 'unreadable');
      const result = await engine.accept(task.id, reviewOf(task));
      assert.equal(result.status, 'needs_check');
      assert.equal(result.errorCode, 'interrupted-merge');
    });
  });

  it('keeps a cancel across a restart while the session is still running, then finishes it as canceled', async () => {
    const box = harness({ inspect: async () => ({ exists: true, active: true, permission: false, status: 'running' }) });
    let seeded: Task | null = null;
    await withEngine(box, async engine => {
      await engine.recover();
      const task = seeded as unknown as Task;
      assert.equal(statusOf(engine, task.id), 'canceling');
      assert.deepEqual(box.cancels, ['agent-seeded']);
      await engine.onTurnEnded({ agentId: 'agent-seeded', turnId: 'late', outcome: { kind: 'completed' } });
      assert.equal(statusOf(engine, task.id), 'canceled');
      assert.equal(box.captures.length, 0);
    }, async dir => { seeded = await seed(dir, { status: 'canceling' }); });
  });

  it('finishes a cancel on restart when the session is gone', async () => {
    const box = harness({ inspect: async () => ({ exists: false, active: false, permission: false, status: null }) });
    await withEngine(box, async engine => {
      await engine.recover();
      assert.equal(engine.list().tasks[0]?.status, 'canceled');
    }, async dir => { await seed(dir, { status: 'canceling' }); });
  });

  it('does not call a session missing when the agent lookup itself fails on restart', async () => {
    const box = harness({ find: async () => { throw new Error('socket closed'); } });
    await withEngine(box, async engine => {
      await engine.recover();
      const task = engine.list().tasks[0];
      assert.equal(task?.status, 'running');
      assert.equal(task?.errorCode, 'gateway-unavailable');
    }, async dir => { await seed(dir, { agentId: null }); });
  });

  it('merges one review while another task in the same repository is still running', async () => {
    const box = harness();
    await withEngine(box, async engine => {
      const task = await reviewed(box, engine, 'first');
      const other = await draft(engine, 'other');
      await engine.startTask(other.id);
      await waitFor(() => statusOf(engine, other.id) === 'running');
      const accepted = engine.accept(task.id, reviewOf(task));
      const timeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 1000));
      const result = await Promise.race([accepted, timeout]);
      assert.notEqual(result, 'timeout', 'accept waited for the other task to finish');
      assert.equal((result as Task).status, 'merged');
    });
  });

  it('gives a sent-back round the original task as well as the requested change', async () => {
    const box = harness();
    await withEngine(box, async engine => {
      const task = await reviewed(box, engine, 'pagination');
      await engine.continue(task.id, 'also handle empty pages');
      await waitFor(() => box.prompts.length === 2);
      assert.equal(box.prompts[0], 'do pagination');
      assert.match(box.prompts[1] ?? '', /do pagination/);
      assert.match(box.prompts[1] ?? '', /also handle empty pages/);
    });
  });

  it('stays waiting for permission until every pending request is resolved', async () => {
    const box = harness();
    await withEngine(box, async engine => {
      const task = await draft(engine, 'perm');
      await engine.startTask(task.id);
      await waitFor(() => statusOf(engine, task.id) === 'running');
      const agentId = box.created[0] ?? '';
      await engine.onPermissionRequested(agentId, 'p1');
      await engine.onPermissionRequested(agentId, 'p2');
      assert.equal(statusOf(engine, task.id), 'needs_attention');
      await engine.onPermissionResolved(agentId, 'p1');
      assert.equal(statusOf(engine, task.id), 'needs_attention');
      await engine.onPermissionResolved(agentId, 'p2');
      assert.equal(statusOf(engine, task.id), 'running');
    });
  });

  it('does not bring back a draft canceled while Start all is running', async () => {
    const box = harness();
    await withEngine(box, async engine => {
      await draft(engine, 'a');
      const second = await draft(engine, 'b');
      const starting = engine.startQueue(null);
      const canceling = engine.cancel(second.id);
      await Promise.all([starting, canceling]);
      assert.equal(statusOf(engine, second.id), 'canceled');
      // Wait for the other draft to be dispatched, then check the canceled one was not dispatched with it.
      await waitFor(() => box.created.length === 1);
      assert.equal(statusOf(engine, second.id), 'canceled');
      assert.equal(box.created.length, 1);
    });
  });
});

describe('cleanup after a merge', () => {
  it('archives the sessions, then removes the worktree, then deletes the merged branch', async () => {
    const box = harness();
    await withEngine(box, async engine => {
      const task = await reviewed(box, engine, 'tidy');
      const merged = await engine.accept(task.id, reviewOf(task));
      assert.equal(merged.status, 'merged');
      assert.deepEqual(box.archived, [{ taskId: task.id, workspaceId: 'ws-1', worktree: `/wt/${task.id}` }]);
      assert.deepEqual(box.removed, [`/wt/${task.id}`]);
      assert.deepEqual(box.deleted, [{ branch: `paseo-todo/${task.id}`, expectedHead: R, targetBranch: 'main' }]);
      assert.deepEqual({ ...merged.cleanup, at: 0 }, { sessions: true, worktree: true, branch: true, error: null, at: 0 });
    });
  });

  it('leaves the worktree and branch while the sessions cannot be archived, and finishes on a retry', async () => {
    let down = true;
    const box = harness({ archive: async () => { if (down) throw new Error('daemon unreachable'); } });
    await withEngine(box, async engine => {
      const task = await reviewed(box, engine, 'later');
      const merged = await engine.accept(task.id, reviewOf(task));
      assert.equal(merged.status, 'merged');
      assert.equal(merged.cleanup?.sessions, false);
      assert.match(merged.cleanup?.error ?? '', /daemon unreachable/);
      assert.deepEqual(box.removed, []);
      assert.deepEqual(box.deleted, []);
      down = false;
      const retried = await engine.cleanup(task.id);
      assert.deepEqual({ ...retried.cleanup, at: 0 }, { sessions: true, worktree: true, branch: true, error: null, at: 0 });
      assert.equal(box.removed.length, 1);
      assert.equal(box.deleted.length, 1);
    });
  });

  it('keeps the branch when the worktree cannot be removed', async () => {
    const box = harness({ removeWorktree: async () => { throw new Error('contains untracked files'); } });
    await withEngine(box, async engine => {
      const task = await reviewed(box, engine, 'dirty');
      const merged = await engine.accept(task.id, reviewOf(task));
      assert.equal(merged.status, 'merged');
      assert.equal(merged.cleanup?.sessions, true);
      assert.equal(merged.cleanup?.worktree, false);
      assert.equal(merged.cleanup?.branch, false);
      assert.match(merged.cleanup?.error ?? '', /untracked/);
      assert.deepEqual(box.deleted, []);
    });
  });

  it('refuses to clean up a task that has not merged', async () => {
    const box = harness();
    await withEngine(box, async engine => {
      const task = await reviewed(box, engine, 'open');
      await assert.rejects(engine.cleanup(task.id), /cleanup-rejected/);
      assert.deepEqual(box.archived, []);
    });
  });
});

function collaborationSnapshot(mode: TaskCollaboration['mode'] = 'full'): TaskCollaboration {
  return taskCollaborationSchema.parse({
    mode,
    settings: {
      profiles: [
        { id: 'director', label: 'Design', provider: 'stub/design', transport: 'mcp', instructions: 'Plan carefully.' },
        { id: 'worker', label: 'Work', provider: 'stub/work', transport: 'structured' },
        { id: 'reviewer', label: 'Review', provider: 'stub/review', transport: 'mcp' },
      ],
      directorProfileId: 'director',
      workerProfileId: 'worker',
      reviewerProfileId: 'reviewer',
      rolePrompts: { plan: 'Plan the work.', execute: 'Keep behavior.', review: 'Check the diff.' },
      maxReworks: 1,
      requirePlanApproval: true,
    },
  });
}

/** In-memory host run. Open resets the live run; resync and control report that run, not a string the engine merely stores. */
class CollaborationHost {
  phase: string | null = null;
  control = 'running';
  confirmation: 'plan' | 'final' | null = null;
  message = '';
  error: string | null = null;
  childRunning = false;
  isolation: 'local' | 'worktree' | null = 'local';
  failOpen = false;
  readonly opens: Array<{ requestId: string; workspaceId: string; goal?: string; fresh?: boolean; collaboration: TaskCollaboration }> = [];
  readonly controls: Array<{ id: string; action: string }> = [];
  readonly resyncs: string[] = [];
  readonly events: string[] = [];

  readonly port: CollaborationPort = {
    catalog: async () => { throw new Error('launch must not read host collaboration settings'); },
    open: async input => {
      if (this.failOpen) throw todoError('collaboration-unavailable');
      this.events.push('open');
      this.opens.push({
        requestId: input.requestId, workspaceId: input.workspaceId, goal: input.goal, fresh: input.fresh, collaboration: input.collaboration,
      });
      this.phase = null;
      this.control = 'running';
      this.confirmation = null;
      this.message = '';
      this.error = null;
      this.childRunning = false;
      return this.opened(input.requestId, input.workspaceId, input.collaboration);
    },
    control: async input => {
      this.events.push(`control:${input.action}`);
      this.controls.push(input);
      if (input.action === 'cancel') {
        this.control = 'canceled';
        this.childRunning = false;
      } else if (input.action === 'retry') {
        if (this.control !== 'needs_attention') throw new Error('仅受阻任务可以重试');
        this.control = 'running';
        this.childRunning = true;
      } else {
        throw new Error(`unexpected collaboration control ${input.action}`);
      }
      return this.state(this.conversationForRun(input.id));
    },
    resync: async id => {
      this.resyncs.push(id);
      return this.state(id);
    },
    status: async () => this.state(this.opens.at(-1) ? `chat-${this.opens.at(-1)?.requestId}` : 'chat-none'),
  };

  private opened(requestId: string, workspaceId: string, collaboration: TaskCollaboration): OpenedCollaboration {
    return {
      conversationId: `chat-${requestId}`,
      runId: null,
      agentId: `agent-${requestId}`,
      workspaceId,
      requestId,
      mode: collaboration.mode,
      isolation: this.isolation,
      error: null,
      state: this.state(`chat-${requestId}`),
    };
  }

  private conversationForRun(runId: string): string {
    const requestId = runId.startsWith('run-') ? runId.slice(4) : runId;
    return `chat-${requestId}`;
  }

  private state(conversationId: string): CollaborationState {
    const requestId = conversationId.replace(/^chat-/, '');
    const opened = this.opens.find(item => item.requestId === requestId);
    return {
      settings: null,
      error: null,
      conversations: [{
        id: `chat-${requestId}`,
        requestId,
        workspaceId: opened?.workspaceId ?? 'ws-1',
        agentId: `agent-${requestId}`,
        title: opened?.goal ?? 'task',
        mode: opened?.collaboration.mode,
        ...(this.isolation ? { isolation: this.isolation } : {}),
        ...(this.confirmation ? { confirmation: { kind: this.confirmation, noticeId: 'notice-1' } } : {}),
        ...(this.error ? { error: this.error } : {}),
        ...(this.phase ? {
          run: { id: `run-${requestId}`, phase: this.phase, control: this.control, message: this.message, done: 0, total: 1 },
        } : {}),
      }],
    };
  }
}

async function settled(engine: TodoEngine, id: string): Promise<Task> {
  await engine.read(id);
  return engine.list().tasks.find(task => task.id === id) as Task;
}

describe('collaboration lifecycle', () => {
  it('waits for an in-flight collaboration sync before releasing the store lock', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    await withEngine(box, async (engine, dir) => {
      const task = await engine.createTask({
        title: 'Shutdown', prompt: 'Do the work', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      await settled(engine, task.id);
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const resync = host.port.resync;
      host.port.resync = async id => { entered(); await gate; return resync(id); };
      const reading = engine.read(task.id);
      await started;
      let closed = false;
      const closing = engine.dispose().then(() => { closed = true; });
      try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(closed, false);
        const contender = await TaskStore.open(dir);
        assert.equal(contender.loadError, 'store-locked');
        await contender.dispose();
      } finally {
        release();
        await Promise.all([reading, closing]);
      }
      const reopened = await TaskStore.open(dir);
      assert.equal(reopened.loadError, null);
      await reopened.dispose();
      await assert.rejects(engine.retry(task.id), /retry-rejected/);
      assert.equal(host.opens.length, 1);
    });
  });

  it('does not treat a cancellation error as proof that the host run stopped', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Cancel', prompt: 'Do the work', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      host.phase = 'executing';
      await settled(engine, task.id);
      const control = host.port.control;
      host.port.control = async () => { throw new Error('run could not be canceled'); };
      assert.equal((await engine.cancel(task.id)).status, 'canceling');
      assert.equal(box.cancels.length, 0);
      host.port.control = control;
      await engine.recover();
      assert.equal(engine.list().tasks[0]?.status, 'canceled');
    });
  });

  it('does not open a new run while the previous main agent is still active', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port, inspect: async () => ({ exists: true, active: true, permission: false, status: 'running' }) });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Continue', prompt: 'Do the work', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      host.phase = 'awaiting_acceptance';
      host.control = 'paused';
      await settled(engine, task.id);
      await assert.rejects(engine.continue(task.id, 'More work'), /agent-busy/);
      assert.equal(host.opens.length, 1);
      assert.equal(host.controls.at(-1)?.action, 'cancel');
    });
  });

  it('queues a blocked-run retry behind another task in the same repository', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Blocked', prompt: 'Do the work', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      host.phase = 'executing';
      host.control = 'needs_attention';
      const blocked = await settled(engine, task.id);
      assert.equal(blocked.status, 'needs_check');
      const other = await draft(engine, 'Other');
      await engine.startTask(other.id);
      await waitFor(() => engine.list().tasks.find(item => item.id === other.id)?.status === 'running');
      const queued = await engine.retry(task.id);
      assert.equal(queued.status, 'queued');
      assert.equal(queued.operationId, blocked.operationId);
      assert.equal(host.controls.length, 0);
      assert.equal(host.childRunning, false);
      const agentId = engine.list().tasks.find(item => item.id === other.id)?.agentId ?? '';
      await engine.onTurnEnded({ agentId, turnId: 'other-done', outcome: { kind: 'completed' } });
      await waitFor(() => engine.list().tasks.find(item => item.id === task.id)?.status === 'running');
      assert.equal(host.controls.at(-1)?.action, 'retry');
      assert.equal(host.opens.length, 1);
      assert.equal(host.childRunning, true);
      assert.equal(engine.list().tasks.find(item => item.id === task.id)?.operationId, blocked.operationId);
    });
  });

  it('does not recapture a completed run after its bound result or target changes', async () => {
    for (const changed of [
      { head: OTHER, tree: T, clean: true, targetHead: H },
      { head: R, tree: T, clean: true, targetHead: OTHER },
    ]) {
      const host = new CollaborationHost();
      const box = harness({ collaboration: host.port });
      await withEngine(box, async engine => {
        const task = await engine.createTask({
          title: 'Binding', prompt: 'Do the work', repository: REPO, projectId: null, projectName: null,
          targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
        });
        await engine.startTask(task.id);
        await waitFor(() => engine.list().tasks[0]?.status === 'running');
        host.phase = 'completed';
        const reviewed = await settled(engine, task.id);
        assert.equal(reviewed.status, 'awaiting_review');
        assert.equal(box.captures.length, 1);
        box.git.snapshot = async () => changed;
        assert.equal((await settled(engine, task.id)).status, 'needs_check');
        const again = await settled(engine, task.id);
        assert.equal(again.status, 'needs_check');
        assert.equal(again.review, null);
        assert.equal(again.errorCode, 'binding-stale');
        assert.equal(box.captures.length, 1);
        await assert.rejects(engine.accept(task.id, reviewOf(reviewed)), /accept-rejected/);
        assert.equal(box.prepares.length, 0);
      });
    }
  });

  it('rechecks session acceptance after the asynchronous agent inspection', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Acceptance', prompt: 'Do the work', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      host.phase = 'completed';
      const reviewed = await settled(engine, task.id);
      box.agents.inspect = async () => {
        host.phase = 'awaiting_acceptance';
        host.control = 'paused';
        host.confirmation = 'final';
        await engine.read(task.id);
        return idle();
      };
      await assert.rejects(engine.accept(task.id, reviewOf(reviewed)), /collaboration-acceptance-pending/);
      assert.equal(box.prepares.length, 0);
    });
  });

  it('observes collaboration completion without a page poll or main-agent event', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Background', prompt: 'Do the work', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      await settled(engine, task.id);
      host.phase = 'awaiting_acceptance';
      host.control = 'paused';
      host.confirmation = 'final';
      // Only inspect a git effect here: engine.list/read would themselves trigger synchronization.
      await waitFor(() => box.captures.length === 1, 3500);
      assert.equal((await settled(engine, task.id)).status, 'awaiting_review');
    });
  });

  it('recovers a host conversation whose open response was lost without opening another one', async () => {
    const host = new CollaborationHost();
    const open = host.port.open;
    host.port.open = async input => {
      await open(input);
      host.phase = 'executing';
      throw new Error('response lost');
    };
    const box = harness({ collaboration: host.port });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Lost reply', prompt: 'Do the work', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      const current = await settled(engine, task.id);
      assert.equal(current.collaborationConversationId, `chat-${current.operationId}`);
      assert.equal(current.collaborationRunId, `run-${current.operationId}`);
      assert.equal(host.opens.length, 1);
      assert.equal(box.created.length, 0);
      await engine.cancel(task.id);
      assert.equal(host.controls.at(-1)?.action, 'cancel');
      assert.equal(engine.list().tasks[0]?.status, 'canceled');
    });
  });

  it('opens the saved snapshot on the task worktree before any prompt, from start and start-all', async () => {
    const host = new CollaborationHost();
    const full = collaborationSnapshot('full');
    const review = collaborationSnapshot('execute_review');
    const box = harness({ collaboration: host.port });
    await withEngine(box, async engine => {
      const first = await engine.createTask({
        title: 'Full', prompt: 'Ship the queue', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: full,
      });
      const second = await engine.createTask({
        title: 'Review', prompt: 'Fix the gate', repository: '/tmp/paseo-todo-other', projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: review,
      });
      await engine.startTask(first.id);
      await engine.startQueue('/tmp/paseo-todo-other');
      await waitFor(() => engine.list().tasks.every(task => task.status === 'running'));
      assert.equal(box.created.length, 0);
      assert.equal(box.sent.length, 0);
      assert.deepEqual(box.workspaces, [`/wt/${first.id}`, `/wt/${second.id}`]);
      assert.deepEqual(host.events.filter(event => event === 'open'), ['open', 'open']);
      assert.deepEqual(host.opens.map(item => item.collaboration), [full, review]);
      assert.deepEqual(host.opens.map(item => item.goal), ['Ship the queue', 'Fix the gate']);
      assert.deepEqual(host.opens.map(item => item.requestId), [
        engine.list().tasks.find(task => task.id === first.id)?.operationId,
        engine.list().tasks.find(task => task.id === second.id)?.operationId,
      ]);
      assert.equal(host.opens.every(item => item.fresh === true), true);
      assert.equal(host.controls.some(item => item.action === 'approve_plan' || item.action === 'accept_final'), false);
      const changed = collaborationSnapshot('full');
      changed.settings.rolePrompts = { plan: 'A different global prompt.' };
      assert.equal(host.opens[0]?.collaboration.settings.rolePrompts?.plan, 'Plan the work.');
      assert.notEqual(host.opens[0]?.collaboration, changed);
    });
  });

  it('keeps one operation across restart and does not open a second conversation for it', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    const dir = await mkdtemp(join(tmpdir(), 'todo-collab-'));
    try {
      const snapshot = collaborationSnapshot();
      await seed(dir, {
        status: 'preparing', collaboration: snapshot, collaborationConversationId: null, collaborationRunId: null,
        agentId: null, workspaceId: null, operationId: '00000000-0000-4000-8000-00000000beef',
        operationIds: ['00000000-0000-4000-8000-00000000beef'],
      });
      const engine = await box.open(dir);
      await engine.recover();
      const started = await settled(engine, '00000000-0000-4000-8000-00000000abcd');
      assert.equal(started.status, 'running');
      assert.equal(started.operationId, '00000000-0000-4000-8000-00000000beef');
      assert.equal(host.opens.length, 1);
      assert.equal(host.opens[0]?.requestId, '00000000-0000-4000-8000-00000000beef');
      assert.equal(host.opens[0]?.goal, 'do seeded');
      assert.equal(box.created.length, 0);
      await engine.dispose();

      const restarted = await box.open(dir);
      await restarted.recover();
      const again = await settled(restarted, started.id);
      assert.equal(again.status, 'running');
      assert.equal(again.operationId, started.operationId);
      assert.equal(again.collaborationConversationId, started.collaborationConversationId);
      assert.equal(host.opens.length, 1);
      assert.ok(host.resyncs.includes(started.collaborationConversationId ?? ''));
      await restarted.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not bind a review while the run is still working, waiting for a plan, or blocked', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Long', prompt: 'Do the long job', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      await settled(engine, task.id);
      const agentId = engine.list().tasks[0]?.agentId ?? '';
      await engine.onPermissionRequested(agentId, 'perm-1');
      assert.equal((await settled(engine, task.id)).status, 'running');
      await engine.onPermissionResolved(agentId, 'perm-1');
      const phases = [
        { phase: null, control: 'running', confirmation: null as 'plan' | 'final' | null },
        { phase: 'planning', control: 'paused', confirmation: 'plan' as const },
        { phase: 'executing', control: 'running', confirmation: null },
        { phase: 'reviewing', control: 'running', confirmation: null },
        { phase: 'final_review', control: 'running', confirmation: null },
      ];
      for (const step of phases) {
        host.phase = step.phase;
        host.control = step.control;
        host.confirmation = step.confirmation;
        host.childRunning = step.phase !== null;
        await engine.onTurnEnded({ agentId, turnId: `turn-${step.phase ?? 'start'}`, outcome: { kind: 'completed' } });
        const current = await settled(engine, task.id);
        assert.equal(current.status, 'running', step.phase ?? 'start');
        assert.equal(current.review, null);
        assert.equal(box.captures.length, 0);
        assert.equal(box.prepares.length, 0);
      }
      await engine.onTurnEnded({ agentId, turnId: 'turn-failed', outcome: { kind: 'failed', error: 'provider reset' } });
      assert.equal((await settled(engine, task.id)).status, 'running');
      host.phase = 'executing';
      host.control = 'needs_attention';
      host.message = '执行受阻：缺少接口';
      host.childRunning = false;
      const blocked = await settled(engine, task.id);
      assert.equal(blocked.status, 'needs_check');
      assert.equal(blocked.errorCode, 'collaboration-blocked');
      assert.match(blocked.errorDetail ?? '', /缺少接口/);
      assert.equal(blocked.review, null);
      assert.equal(box.captures.length, 0);
      const operationId = blocked.operationId;
      const retried = await engine.retry(task.id);
      assert.equal(retried.operationId, operationId);
      await waitFor(() => host.controls.at(-1)?.action === 'retry');
      assert.equal(host.opens.length, 1);
      assert.equal(host.controls.at(-1)?.action, 'retry');
      assert.equal(host.childRunning, true);
      assert.equal((await settled(engine, task.id)).status, 'running');
    });
  });

  it('binds the worktree only at final acceptance, and merge waits for the user to accept in the session', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Ship', prompt: 'Ship the queue', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      const other = await engine.createTask({
        title: 'Next', prompt: 'Do the next one', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null,
      });
      await engine.startQueue(null);
      await waitFor(() => engine.list().tasks.find(item => item.id === task.id)?.status === 'running');
      assert.equal(engine.list().tasks.find(item => item.id === other.id)?.status, 'queued');
      assert.equal(box.created.length, 0);
      await settled(engine, task.id);
      host.phase = 'awaiting_acceptance';
      host.control = 'paused';
      host.confirmation = 'final';
      host.message = '最终审核通过，等待你验收';
      host.childRunning = false;
      const waiting = await settled(engine, task.id);
      assert.equal(waiting.status, 'awaiting_review');
      assert.equal(waiting.collaborationAcceptance, 'pending');
      assert.equal(waiting.errorCode, 'collaboration-acceptance-pending');
      assert.equal(waiting.review?.turnId, `collaboration:${waiting.collaborationRunId}`);
      assert.equal(box.captures.length, 1);
      await waitFor(() => engine.list().tasks.find(item => item.id === other.id)?.status === 'running');
      assert.equal(box.created.length, 1);
      await assert.rejects(engine.accept(task.id, reviewOf(waiting)), /collaboration-acceptance-pending/);
      assert.equal(box.prepares.length, 0);
      host.control = 'canceled';
      host.message = '你选择不采纳并结束任务';
      const rejected = await settled(engine, task.id);
      assert.equal(rejected.status, 'canceled');
      assert.equal(rejected.review, null);
      assert.equal(rejected.errorCode, 'collaboration-declined');
      await assert.rejects(engine.accept(task.id, reviewOf(waiting)), /collaboration-declined|accept-rejected/);
      assert.equal(box.prepares.length, 0);
    });
  });

  it('merges only after the session acceptance, and still checks the saved binding', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Ship', prompt: 'Ship the queue', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      await settled(engine, task.id);
      host.phase = 'awaiting_acceptance';
      host.control = 'paused';
      host.confirmation = 'final';
      host.message = '等待你验收';
      const waiting = await settled(engine, task.id);
      assert.equal(waiting.collaborationAcceptance, 'pending');
      host.phase = 'completed';
      host.control = 'running';
      host.confirmation = null;
      host.message = '你已验收通过';
      const ready = await settled(engine, task.id);
      assert.equal(ready.status, 'awaiting_review');
      assert.equal(ready.collaborationAcceptance, 'accepted');
      assert.equal(ready.review?.resultCommit, waiting.review?.resultCommit);
      assert.equal(box.captures.length, 1);
      await assert.rejects(engine.accept(task.id, { ...reviewOf(ready), resultTree: OTHER }), /stale-client-review/);
      assert.equal(box.prepares.length, 0);
      const merged = await engine.accept(task.id, reviewOf(ready));
      assert.equal(merged.status, 'merged');
      assert.equal(box.prepares.length, 1);
      assert.equal(host.controls.some(item => item.action !== 'cancel' && item.action !== 'retry'), false);
    });
  });

  it('cancels the host run before the main agent, and retry or continue starts one new run from the saved snapshot', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    const order: string[] = [];
    await withEngine(box, async engine => {
      const snapshot = collaborationSnapshot();
      const task = await engine.createTask({
        title: 'Ship', prompt: 'Ship the queue', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: snapshot,
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      await settled(engine, task.id);
      host.phase = 'executing';
      host.control = 'running';
      host.childRunning = true;
      const running = await settled(engine, task.id);
      assert.equal(running.collaborationRunId, `run-${running.operationId}`);
      const originalCancel = box.agents.cancel;
      box.agents.cancel = async agentId => {
        order.push(`agent:${agentId}`);
        host.events.push('agent-cancel');
        await originalCancel(agentId);
      };
      const previous = host.events.length;
      await engine.cancel(task.id);
      assert.equal(host.childRunning, false);
      assert.equal(engine.list().tasks[0]?.status, 'canceled');
      const duringCancel = host.events.slice(previous);
      assert.deepEqual(duringCancel, ['control:cancel', 'agent-cancel']);
      assert.equal(host.controls.at(-1)?.id, running.collaborationRunId);
      assert.equal(box.captures.length, 0);

      host.events.length = 0;
      await engine.retry(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      const retried = await settled(engine, task.id);
      assert.notEqual(retried.operationId, running.operationId);
      assert.equal(host.opens.at(-1)?.requestId, retried.operationId);
      assert.deepEqual(host.opens.at(-1)?.collaboration, snapshot);
      assert.equal(host.opens.at(-1)?.goal, 'Ship the queue');
      assert.equal(host.events[0], 'control:cancel');
      assert.ok(host.events.indexOf('open') > host.events.indexOf('control:cancel'));
      assert.equal(box.created.length, 0);

      host.phase = 'awaiting_acceptance';
      host.control = 'paused';
      host.confirmation = 'final';
      host.message = '等待你验收';
      await settled(engine, task.id);
      host.events.length = 0;
      await engine.continue(task.id, 'also handle an empty list');
      await waitFor(() => engine.list().tasks[0]?.status === 'running' && engine.list().tasks[0]?.operationId !== retried.operationId);
      const continued = await settled(engine, task.id);
      assert.deepEqual(continued.collaboration, snapshot);
      assert.match(host.opens.at(-1)?.goal ?? '', /Ship the queue/);
      assert.match(host.opens.at(-1)?.goal ?? '', /also handle an empty list/);
      assert.equal(host.events[0], 'control:cancel');
      assert.equal(host.childRunning, false);
      assert.equal(box.created.length, 0);
      assert.deepEqual(order, [`agent:${running.agentId}`, `agent:${running.agentId}`, `agent:${retried.agentId}`]);
    });
  });

  it('returns to the same run when the session asks for changes, and cancel while waiting for acceptance stops that run', async () => {
    const host = new CollaborationHost();
    const box = harness({ collaboration: host.port });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Rework', prompt: 'Ship the queue', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      await settled(engine, task.id);
      host.phase = 'awaiting_acceptance';
      host.control = 'paused';
      host.confirmation = 'final';
      host.message = '等待你验收';
      const waiting = await settled(engine, task.id);
      assert.equal(waiting.collaborationAcceptance, 'pending');
      const operationId = waiting.operationId;
      host.phase = 'executing';
      host.control = 'running';
      host.confirmation = null;
      host.message = '审核要求修改';
      host.childRunning = true;
      const rework = await settled(engine, task.id);
      assert.equal(rework.status, 'running');
      assert.equal(rework.review, null);
      assert.equal(rework.collaborationAcceptance, null);
      assert.equal(rework.operationId, operationId);
      assert.equal(host.opens.length, 1);
      assert.equal(box.captures.length, 1);
      assert.equal(box.prepares.length, 0);
      host.phase = 'awaiting_acceptance';
      host.control = 'paused';
      host.confirmation = 'final';
      host.childRunning = true;
      const again = await settled(engine, task.id);
      assert.equal(again.status, 'awaiting_review');
      assert.equal(again.collaborationAcceptance, 'pending');
      assert.equal(box.captures.length, 2);
      const before = host.controls.length;
      await engine.cancel(task.id);
      assert.equal(engine.list().tasks[0]?.status, 'canceled');
      assert.equal(host.controls[before]?.action, 'cancel');
      assert.equal(host.controls[before]?.id, again.collaborationRunId);
      assert.equal(host.childRunning, false);
      assert.equal(box.prepares.length, 0);
      await assert.rejects(engine.accept(task.id, reviewOf(again)), /collaboration-declined|accept-rejected/);
    });
  });

  it('sends the snapshot on the public open frame after the workspace exists, and does not save host settings', async () => {
    const snapshot = collaborationSnapshot('execute_review');
    const frames: Array<{ command?: string; input?: Record<string, unknown> }> = [];
    const order: string[] = [];
    const opened: Array<Record<string, unknown>> = [];
    const peer = {
      handler: null as ((data: string) => void) | null,
      onMessage(handler: (data: string) => void) { this.handler = handler; },
      onClose() {},
      close() {},
      send(data: string) {
        const message = JSON.parse(data) as { type?: string; message?: { requestId?: string; command?: string; input?: Record<string, unknown> } };
        if (message.type === 'hello') {
          this.handler?.(JSON.stringify({ type: 'session', message: { type: 'status', payload: { status: 'server_info', features: {
            collaboration: true, collaborationExecuteReview: true, collaborationInlineModels: true, collaborationWorktree: true,
          } } } }));
          return;
        }
        const inner = message.message;
        if (!inner?.command) return;
        frames.push({ command: inner.command, input: inner.input });
        order.push(inner.command);
        const input = inner.input ?? {};
        if (inner.command === 'conversation.open') {
          const requestId = String(input.requestId ?? '');
          opened.push({
            id: `chat-${requestId}`, requestId, workspaceId: String(input.workspaceId), agentId: `agent-${requestId}`,
            title: 'task', mode: input.mode, isolation: input.isolation,
          });
        }
        this.handler?.(JSON.stringify({
          type: 'session',
          message: { type: 'collaboration.command.response', payload: { requestId: inner.requestId, state: {
            settings: null, rolePrompts: snapshot.settings.rolePrompts, error: null, conversations: opened,
          } } },
        }));
      },
    };
    const port = new PaseoCollaborationPort(new CollaborationWire({
      dial: async () => peer,
      hello: () => ({ type: 'hello', clientId: 'paseo-todo-collaboration' }),
    }));
    const box = harness({ collaboration: port });
    const workspace = box.agents.openWorkspace;
    box.agents.openWorkspace = async (cwd, title) => {
      order.push(`workspace:${cwd}`);
      return workspace(cwd, title);
    };
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Review', prompt: 'Check the gate', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: snapshot,
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      const open = frames.find(frame => frame.command === 'conversation.open');
      assert.ok(open);
      assert.equal(open?.input?.isolation, 'local');
      assert.equal(open?.input?.mode, 'execute_review');
      assert.equal(open?.input?.goal, 'Check the gate');
      assert.equal(open?.input?.requestId, engine.list().tasks[0]?.operationId);
      assert.deepEqual(open?.input?.settings, snapshot.settings);
      assert.equal(frames.some(frame => frame.command === 'settings.save' || frame.command === 'prompts.save'), false);
      assert.equal(box.created.length, 0);
      assert.equal(box.sent.length, 0);
      assert.equal(order[0], `workspace:/wt/${task.id}`);
      assert.equal(box.workspaceTitles[0], 'Review');
      assert.equal(order[1], 'status');
      assert.equal(order[2], 'conversation.open');
    });
  });

  it('throttles background collaboration syncs while a read always resyncs', async () => {
    const host = new CollaborationHost();
    let tick = 0;
    const box = harness({ collaboration: host.port, clock: () => tick });
    await withEngine(box, async engine => {
      const task = await engine.createTask({
        title: 'Poll', prompt: 'Do the work', repository: REPO, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: collaborationSnapshot(),
      });
      await engine.startTask(task.id);
      await waitFor(() => engine.list().tasks[0]?.status === 'running');
      await new Promise(resolve => setTimeout(resolve, 20));
      const synced = host.resyncs.length;
      // Inside the window, board polls do not resync.
      engine.list();
      engine.list();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(host.resyncs.length, synced);
      // A read's required sync always runs.
      await engine.read(task.id);
      assert.equal(host.resyncs.length, synced + 1);
      // Past the window, a board poll resyncs again.
      tick += 2000;
      engine.list();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(host.resyncs.length, synced + 2);
    });
  });
});
