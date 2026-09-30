import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AgentInspection, AgentPort } from '../server/agents';
import { TodoEngine, type TurnEvent } from '../server/engine';
import type { GitPort, PrepareOk } from '../server/git';
import { TaskStore } from '../server/store';
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

async function waitFor(pred: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
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
} = {}) {
  const created: string[] = [];
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
    async send(input) {
      sent.push(input.agentId);
    },
    async cancel(agentId) { cancels.push(agentId); await options.cancel?.(agentId); },
    inspect: options.inspect ?? (async () => idle()),
    findByOperation: options.find ?? (async () => null),
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
  };
  let now = 1;
  return {
    created, sent, captures, prepares, prompts, cancels, agents, git,
    engine: null as unknown as TodoEngine,
    async open(dir: string) {
      const store = await TaskStore.open(dir);
      const engine = new TodoEngine({ store, git, agents, now: () => now++, newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}` });
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
    operationId: '00000000-0000-4000-8000-00000000beef', operationIds: ['00000000-0000-4000-8000-00000000beef'], review: null,
    lastOutcome: null, pendingMergeCommit: null, mergeCommit: null, mergeMethod: null, errorCode: null, errorDetail: null,
    createdAt: 1, updatedAt: 1, ...patch,
  };
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
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(statusOf(engine, second.id), 'canceled');
      assert.equal(box.created.length, 1);
    });
  });
});
