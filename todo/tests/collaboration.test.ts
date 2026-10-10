import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AgentPort } from '../server/agents';
import { CollaborationWire, PaseoCollaborationPort, type FramePeer } from '../server/collaboration';
import { TodoEngine } from '../server/engine';
import type { GitFailure, GitPort } from '../server/git';
import { TaskStore } from '../server/store';
import {
  blankCollaborationDraft,
  collaborationBlock,
  collaborationCatalogSchema,
  collaborationEditBlocksStart,
  collaborationModeLabel,
  collaborationSettingsSchema,
  collaborationStatus,
  collaborationWarning,
  draftFromCollaboration,
  foreignProviderIds,
  inheritCollaborationDraft,
  readCollaborationDefaults,
  sameCollaborationDraft,
  selectRoleModel,
  snapshotFromDraft,
  storedDefault,
  taskCollaborationSchema,
  writeCollaborationDefault,
  type CollaborationCapabilities,
  type CollaborationDefaultStore,
  type CollaborationState,
  type CollaborationWireCommand,
  type TaskCollaboration,
} from '../shared/collaboration';
import { explain } from '../shared/errors';

const id = '11111111-1111-4111-8111-111111111111';
const repo = '/tmp/paseo-todo-repo';

function settingsOf(reviewer: boolean) {
  return collaborationSettingsSchema.parse({
    profiles: [
      { id: 'director', label: 'Design', provider: 'stub/design', transport: 'mcp', instructions: 'Plan carefully.' },
      { id: 'worker', label: 'Work', provider: 'stub/work', transport: 'structured', modeId: 'code' },
      ...(reviewer ? [{ id: 'reviewer', label: 'Review', provider: 'stub/review', transport: 'mcp' as const }] : []),
    ],
    directorProfileId: 'director',
    workerProfileId: 'worker',
    ...(reviewer ? { reviewerProfileId: 'reviewer' } : {}),
    rolePrompts: { plan: 'Plan the work.', execute: 'Keep existing behavior.', review: 'Check the diff.' },
    maxReworks: 1,
    runTimeoutMs: 3_600_000,
    requirePlanApproval: true,
    verificationCommands: [{ label: 'test', command: 'npm', args: ['test'], timeoutMs: 60_000 }],
    categoryOverrides: { backend: 'worker' },
  });
}

function snapshot(mode: TaskCollaboration['mode']): TaskCollaboration {
  return taskCollaborationSchema.parse({ mode, settings: settingsOf(mode === 'execute_review' || mode === 'full') });
}

function git(): GitPort {
  const sha = 'ab'.repeat(20);
  const failure: GitFailure = { ok: false, reason: 'conflict', detail: 'unused' };
  return {
    resolveRepository: async path => path,
    listBranches: async () => ({ branches: ['main'], head: 'main' }),
    branchExists: async () => true,
    ensureWorktree: async input => ({ worktree: `/wt/${input.taskId}`, branch: input.branch, baseCommit: sha }),
    capture: async () => ({ commit: sha, tree: sha }),
    snapshot: async () => ({ head: sha, tree: sha, clean: true, targetHead: sha }),
    readTargetHead: async () => sha,
    diff: async () => ({ patch: '', files: [], truncated: false }),
    prepareMerge: async () => failure,
    applyMerge: async () => ({ ok: true, mergeCommit: sha, method: 'update-ref' }),
    removeWorktree: async () => undefined,
    deleteBranch: async () => undefined,
    deleteMergedBranch: async () => undefined,
  };
}

function agents(): AgentPort & { created: number } {
  return {
    created: 0,
    async create(input) {
      this.created += 1;
      if (input.collaboration) throw new Error('prompt sent before collaboration opened');
      return { agentId: 'agent-1', workspaceId: 'ws-1' };
    },
    openWorkspace: async () => 'ws-1',
    send: async () => undefined,
    cancel: async () => undefined,
    inspect: async () => ({ exists: true, active: false, permission: false, status: 'idle' }),
    findByOperation: async () => null,
    archiveTask: async () => undefined,
  };
}

class ScriptedPeer implements FramePeer {
  readonly sent: Array<Record<string, unknown>> = [];
  holdOpen = false;
  rejectHello: string | null = null;
  failStatus: string | null = null;
  private listener: ((data: string) => void) | null = null;
  private readonly held: Array<Record<string, unknown>> = [];

  constructor(private readonly features: Record<string, boolean>) {}

  onMessage(handler: (data: string) => void): void {
    this.listener = handler;
  }

  onClose(): void {}

  close(): void {}

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === 'hello') {
      if (this.rejectHello) {
        this.emit({ type: 'hello.rejected', reason: this.rejectHello, accepts: ['password'] });
        return;
      }
      this.emit({ type: 'session', message: { type: 'status', payload: { status: 'server_info', serverId: 'srv', features: this.features } } });
      return;
    }
    const inner = message.message as { type?: string; requestId?: string; command?: string; input?: Record<string, unknown> } | undefined;
    if (inner?.type !== 'collaboration.command.request') return;
    if (inner.command === 'conversation.open' && this.holdOpen) {
      this.held.push(inner as unknown as Record<string, unknown>);
      return;
    }
    this.reply(inner);
  }

  release(): void {
    for (const inner of this.held.splice(0)) this.reply(inner as { requestId?: string; command?: string; input?: Record<string, unknown> });
  }

  commands(): Array<{ command?: string; input?: Record<string, unknown>; requestId?: string }> {
    return this.sent.flatMap(message => {
      const inner = message.message as { command?: string; input?: Record<string, unknown>; requestId?: string } | undefined;
      return inner?.command ? [inner] : [];
    });
  }

  private reply(inner: { requestId?: string; command?: string; input?: Record<string, unknown> }): void {
    if (inner.command === 'status' && this.failStatus) {
      this.emit({ type: 'session', message: { type: 'rpc_error', payload: { requestId: inner.requestId, error: this.failStatus, code: 'collaboration_failed' } } });
      return;
    }
    this.emit({
      type: 'session',
      message: { type: 'collaboration.command.response', payload: { requestId: inner.requestId, state: this.stateFor(inner) } },
    });
  }

  private stateFor(inner: { command?: string; input?: Record<string, unknown> }): CollaborationState {
    if (inner.command === 'conversation.open') {
      const input = inner.input ?? {};
      const sentSettings = input.settings as TaskCollaboration['settings'];
      return {
        settings: null,
        rolePrompts: settingsOf(true).rolePrompts,
        error: null,
        conversations: [{
          id: 'chat-1',
          requestId: String(input.requestId),
          workspaceId: String(input.workspaceId),
          agentId: 'agent-1',
          title: 'task',
          mode: input.mode as TaskCollaboration['mode'],
          isolation: input.isolation as 'local',
          settings: { ...sentSettings, rolePrompts: settingsOf(true).rolePrompts },
        }],
      };
    }
    return { settings: settingsOf(true), rolePrompts: settingsOf(true).rolePrompts, error: null, conversations: [] };
  }

  private emit(value: unknown): void {
    this.listener?.(JSON.stringify(value));
  }
}

function portFor(peer: ScriptedPeer): PaseoCollaborationPort {
  return new PaseoCollaborationPort(new CollaborationWire({
    dial: async () => peer,
    hello: () => ({ type: 'hello', clientId: 'paseo-todo-collaboration' }),
  }));
}

const capable = { collaboration: true, collaborationExecuteReview: true, collaborationInlineModels: true, collaborationWorktree: true };

describe('collaboration snapshot', () => {
  it('requires a real reviewer for execute_review and known profile ids', () => {
    const full = taskCollaborationSchema.safeParse({ mode: 'full', settings: settingsOf(false) });
    const review = taskCollaborationSchema.safeParse({ mode: 'execute_review', settings: settingsOf(false) });
    const reviewed = taskCollaborationSchema.safeParse({ mode: 'execute_review', settings: settingsOf(true) });
    assert.equal(full.success, true);
    assert.equal(review.success, false);
    assert.match(review.success ? '' : review.error.issues.map(issue => issue.message).join('\n'), /独立审核/);
    assert.equal(reviewed.success, true);
    const missing = collaborationSettingsSchema.safeParse({
      profiles: [{ id: 'worker', label: 'Work', provider: 'stub/work' }],
      directorProfileId: 'missing',
      workerProfileId: 'worker',
    });
    assert.equal(missing.success, false);
    assert.match(missing.success ? '' : missing.error.issues.map(issue => issue.message).join('\n'), /不存在的 AI 配置：missing/);
    const duplicate = collaborationSettingsSchema.safeParse({
      profiles: [
        { id: 'worker', label: 'A', provider: 'stub/a' },
        { id: 'worker', label: 'B', provider: 'stub/b' },
      ],
      directorProfileId: 'worker',
      workerProfileId: 'worker',
    });
    assert.equal(duplicate.success, false);
    assert.equal(taskCollaborationSchema.safeParse({ mode: 'full', settings: settingsOf(true), isolation: 'worktree' }).success, false);
  });
});

describe('collaboration adapter', () => {
  it('rejects task role prompts the host would overwrite before opening a conversation', async () => {
    const peer = new ScriptedPeer(capable);
    const saved = snapshot('full');
    saved.settings.rolePrompts = { execute: 'A task-specific instruction' };
    await assert.rejects(portFor(peer).open({ requestId: 'prompt-check', workspaceId: 'ws-1', goal: 'Do the work', collaboration: saved }), /collaboration-prompts-unavailable/);
    assert.deepEqual(peer.commands().map(command => command.command), ['status']);
  });

  it('closes a socket whose dial completes after the wire was closed', async () => {
    const peer = new ScriptedPeer(capable);
    let closed = 0;
    peer.close = () => { closed += 1; };
    let release!: (peer: FramePeer) => void;
    const wire = new CollaborationWire({
      dial: () => new Promise(resolve => { release = resolve; }),
      hello: () => ({ type: 'hello' }),
    });
    const command = wire.command('status', {});
    const rejected = assert.rejects(command, /collaboration wire closed/);
    await wire.close();
    release(peer);
    await rejected;
    assert.equal(closed, 1);
    assert.deepEqual(peer.sent, []);
  });

  it('reads capabilities and status without writing host settings', async () => {
    const peer = new ScriptedPeer(capable);
    const catalog = await portFor(peer).catalog();
    assert.equal(collaborationCatalogSchema.safeParse(catalog).success, true);
    assert.deepEqual(catalog.capabilities, { collaboration: true, executeReview: true, inlineModels: true, worktree: true });
    assert.equal(catalog.settings?.reviewerProfileId, 'reviewer');
    assert.equal(catalog.rolePrompts.review, 'Check the diff.');
    assert.equal(catalog.promptExamples.execute?.includes('Do not alter tests'), true);
    assert.equal(catalog.error, null);
    assert.deepEqual(peer.commands().map(command => command.command), ['status']);
    assert.equal(JSON.stringify(peer.sent).includes('settings.save'), false);
    assert.equal(JSON.stringify(peer.sent).includes('prompts.save'), false);
  });

  it('reports a host that has no collaboration command and does not open one', async () => {
    const peer = new ScriptedPeer({ collaboration: false });
    const catalog = await portFor(peer).catalog();
    assert.equal(catalog.capabilities.collaboration, false);
    assert.equal(catalog.settings, null);
    assert.equal(catalog.error, explain('collaboration-unavailable'));
    assert.deepEqual(peer.commands(), []);
  });

  it('returns the host error from status and still does not save settings', async () => {
    const peer = new ScriptedPeer(capable);
    peer.failStatus = '请先在插件设置停用 paseo-director，再启用内置协作。原任务和配置会保留。';
    const catalog = await portFor(peer).catalog();
    assert.match(catalog.error ?? '', /paseo-director/);
    assert.equal(JSON.stringify(peer.sent).includes('settings.save'), false);
    assert.equal(JSON.stringify(peer.sent).includes('prompts.save'), false);
  });

  it('surfaces hello rejection without a settings write', async () => {
    const peer = new ScriptedPeer(capable);
    peer.rejectHello = 'password_required';
    const catalog = await portFor(peer).catalog();
    assert.match(catalog.error ?? '', /password_required/);
    assert.deepEqual(peer.commands(), []);
  });

  it('opens in the current workspace with the saved snapshot before any task prompt', async () => {
    const peer = new ScriptedPeer(capable);
    const draft = draftFromCollaboration(snapshot('execute_review'));
    assert.ok(draft.worker);
    assert.ok(draft.reviewer);
    draft.worker.thinkingOptionId = 'low';
    draft.reviewer.thinkingOptionId = 'high';
    const collaboration = snapshotFromDraft(draft).collaboration;
    assert.ok(collaboration);
    const opened = await portFor(peer).open({
      requestId: '00000000-0000-4000-8000-000000000001',
      workspaceId: 'ws-1',
      collaboration,
    });
    const open = peer.commands().find(command => command.command === 'conversation.open');
    assert.ok(open);
    assert.equal(open.requestId, '00000000-0000-4000-8000-000000000001');
    assert.equal(open.input?.requestId, open.requestId);
    assert.equal(open.input?.isolation, 'local');
    assert.equal(open.input?.mode, 'execute_review');
    assert.equal(open.input?.fresh, true);
    assert.deepEqual(open.input?.settings, collaboration.settings);
    assert.equal(opened.conversationId, 'chat-1');
    assert.equal(opened.agentId, 'agent-1');
    assert.equal(opened.isolation, 'local');
    assert.equal(JSON.stringify(peer.sent).includes('settings.save'), false);
    assert.equal(peer.commands().some(command => command.command === 'conversation.open' && command.input?.goal), false);
  });

  it('refuses execute_review and per-task settings when the host does not advertise them', async () => {
    const noReview = new ScriptedPeer({ collaboration: true, collaborationInlineModels: true });
    await assert.rejects(
      () => portFor(noReview).open({ requestId: 'req-1', workspaceId: 'ws-1', collaboration: snapshot('execute_review') }),
      /collaboration-unavailable/,
    );
    assert.equal(noReview.commands().some(command => command.command === 'conversation.open'), false);

    const noInline = new ScriptedPeer({ collaboration: true, collaborationExecuteReview: true });
    await assert.rejects(
      () => portFor(noInline).open({ requestId: 'req-2', workspaceId: 'ws-1', collaboration: snapshot('full') }),
      /不会按任务使用协作设置/,
    );
    assert.equal(noInline.commands().some(command => command.command === 'conversation.open'), false);
  });

  it('sends one open when the same request is repeated while the first is in flight', async () => {
    const peer = new ScriptedPeer(capable);
    peer.holdOpen = true;
    const adapter = portFor(peer);
    const input = { requestId: 'req-same', workspaceId: 'ws-1', collaboration: snapshot('full') };
    const first = adapter.open(input);
    const second = adapter.open(input);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(peer.commands().filter(command => command.command === 'conversation.open').length, 1);
    peer.release();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.conversationId, right.conversationId);
  });

  it('refuses to save host settings or prompts through the command wire', async () => {
    const wire = new CollaborationWire({
      dial: async () => { throw new Error('should not dial'); },
      hello: () => ({}),
    });
    await assert.rejects(() => wire.command('settings.save' as CollaborationWireCommand, {}), /refusing settings.save/);
    await assert.rejects(() => wire.command('prompts.save' as CollaborationWireCommand, {}), /refusing prompts.save/);
  });
});

describe('collaboration task records', () => {
  it('persists a snapshot, rejects edits that are not drafts, and does not publish a failed save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'todo-collab-'));
    try {
      let fail = false;
      const store = await TaskStore.open(dir, {
        write: async body => {
          if (fail) throw new Error('disk');
          await writeFile(join(dir, 'state.json'), body);
        },
      });
      const createdAgents = agents();
      let sequence = 0;
      const engine = new TodoEngine({
        store, git: git(), agents: createdAgents, now: () => 5,
        newId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      });
      const collaboration = snapshot('full');
      const task = await engine.createTask({
        title: 'Queue', prompt: 'Do the work', repository: repo, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration,
      });
      assert.deepEqual(task.collaboration, collaboration);
      assert.equal(task.collaborationConversationId, null);
      assert.equal(task.collaborationRunId, null);

      fail = true;
      await assert.rejects(() => engine.updateCollaboration(task.id, snapshot('execute_review')), /disk/);
      assert.deepEqual(engine.list().tasks[0]?.collaboration, collaboration);
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).tasks[0].collaboration, collaboration);
      fail = false;

      const cleared = await engine.updateCollaboration(task.id, null);
      assert.equal(cleared.collaboration, null);
      const saved = await engine.updateCollaboration(task.id, collaboration);
      assert.equal(saved.collaboration?.mode, 'full');

      await engine.startTask(task.id);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (engine.list().tasks.find(item => item.id === task.id)?.status === 'failed') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(engine.list().tasks.find(item => item.id === task.id)?.status, 'failed');
      assert.equal(engine.list().tasks.find(item => item.id === task.id)?.errorCode, 'collaboration-unavailable');
      assert.deepEqual(engine.list().tasks.find(item => item.id === task.id)?.collaboration, collaboration);
      assert.equal(createdAgents.created, 0);

      const plain = await engine.createTask({
        title: 'Plain', prompt: 'Do the plain work', repository: repo, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null,
      });
      await engine.startQueue(null);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (engine.list().tasks.find(item => item.id === plain.id)?.status === 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const tasks = engine.list().tasks;
      assert.equal(tasks.find(item => item.id === task.id)?.status, 'failed');
      assert.equal(tasks.find(item => item.id === task.id)?.errorCode, 'collaboration-unavailable');
      assert.equal(tasks.find(item => item.id === plain.id)?.status, 'running');
      assert.equal(createdAgents.created, 1);
      assert.equal(tasks.find(item => item.id === plain.id)?.collaboration, null);

      await engine.dispose();
      const seeded = await TaskStore.open(dir);
      const lockedId = '22222222-2222-4222-8222-222222222222';
      await seeded.insert({
        ...seeded.get(task.id), id: lockedId, title: 'Locked draft', status: 'draft',
        operationId: '33333333-3333-4333-8333-333333333333', operationIds: ['33333333-3333-4333-8333-333333333333'],
      });
      await seeded.dispose();
      const beforeReject = await readFile(join(dir, 'state.json'), 'utf8');
      const next = new TodoEngine({ store: await TaskStore.open(dir), git: git(), agents: agents(), now: () => 9 });
      await assert.rejects(() => next.updateCollaboration(plain.id, null), /collaboration-rejected/);
      await assert.rejects(() => next.updateCollaboration(lockedId, null), /collaboration-rejected/);
      assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), beforeReject);
      const persisted = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { tasks: Array<{ id: string; collaboration: { mode: string } | null; status: string }> };
      assert.equal(persisted.tasks.find(item => item.id === plain.id)?.status, 'running');
      assert.equal(persisted.tasks.find(item => item.id === lockedId)?.collaboration?.mode, 'full');
      assert.equal(persisted.tasks.find(item => item.id === task.id)?.collaboration?.mode, 'full');
      await next.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an illegal snapshot before a draft is stored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'todo-collab-'));
    try {
      const store = await TaskStore.open(dir);
      const engine = new TodoEngine({ store, git: git(), agents: agents(), now: () => 1 });
      const illegal = { mode: 'execute_review' as const, settings: settingsOf(false) };
      await assert.rejects(() => engine.createTask({
        title: 'Bad', prompt: 'Do the work', repository: repo, projectId: null, projectName: null,
        targetBranch: 'main', provider: 'stub/model', modeId: null, collaboration: illegal,
      }), /collaboration-invalid/);
      assert.equal(engine.list().tasks.length, 0);
      await engine.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function canonical(value: TaskCollaboration): TaskCollaboration {
  return {
    ...value,
    settings: {
      ...value.settings,
      profiles: [...value.settings.profiles].sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

function memoryStore(): CollaborationDefaultStore & { read(): string | null } {
  let raw: string | null = null;
  return {
    read: () => raw,
    getItem: () => raw,
    setItem: (_key, value) => { raw = value; },
  };
}

const readyCapabilities: CollaborationCapabilities = {
  collaboration: true,
  executeReview: true,
  inlineModels: true,
  worktree: true,
};

describe('collaboration drafts', () => {
  it('round-trips shared role profiles and separates them when one role is edited', () => {
    const saved = taskCollaborationSchema.parse({
      mode: 'full',
      settings: {
        profiles: [{ id: 'shared', label: 'Same', provider: 'stub/same', transport: 'mcp' }],
        directorProfileId: 'shared', workerProfileId: 'shared', reviewerProfileId: 'shared',
      },
    });
    const draft = draftFromCollaboration(saved);
    const unchanged = snapshotFromDraft(draft);
    assert.equal(unchanged.error, null);
    assert.deepEqual(unchanged.collaboration?.settings.profiles, saved.settings.profiles);
    assert.ok(draft.director);
    draft.director.model = 'another';
    const changed = snapshotFromDraft(draft);
    assert.equal(changed.error, null);
    const settings = changed.collaboration?.settings;
    assert.ok(settings);
    assert.notEqual(settings.directorProfileId, settings.workerProfileId);
    assert.equal(settings.profiles.find(profile => profile.id === settings.directorProfileId)?.provider, 'stub/another');
    assert.equal(settings.profiles.find(profile => profile.id === settings.workerProfileId)?.provider, 'stub/same');
    assert.equal(settings.reviewerProfileId, 'shared');

    const collision = taskCollaborationSchema.parse({
      mode: 'full',
      settings: {
        ...saved.settings,
        profiles: [...saved.settings.profiles, { id: 'director', label: 'Review', provider: 'stub/review', transport: 'mcp' }],
        reviewerProfileId: 'director', categoryOverrides: { docs: 'director' },
      },
    });
    const edited = draftFromCollaboration(collision);
    assert.ok(edited.director);
    edited.director.model = 'another';
    const split = snapshotFromDraft(edited).collaboration?.settings;
    assert.ok(split);
    assert.notEqual(split.directorProfileId, 'director');
    assert.equal(split.reviewerProfileId, 'director');
    assert.equal(split.categoryOverrides.docs, 'director');
    assert.equal(split.profiles.find(profile => profile.id === 'director')?.provider, 'stub/review');
  });

  it('edits each role thinking level and keeps it through task snapshots and remembered defaults', () => {
    const saved = snapshot('full');
    saved.settings.profiles[0].thinkingOptionId = 'high';
    const draft = draftFromCollaboration(saved);
    assert.equal(draft.director?.thinkingOptionId, 'high');
    assert.ok(draft.director);
    assert.ok(draft.worker);
    assert.ok(draft.reviewer);
    draft.director.thinkingOptionId = 'medium';
    draft.worker.thinkingOptionId = 'low';
    draft.reviewer.thinkingOptionId = 'high';
    const result = snapshotFromDraft(draft);
    assert.equal(result.error, null);
    assert.ok(result.collaboration);
    assert.deepEqual(result.collaboration.settings.profiles.map(profile => [profile.id, profile.thinkingOptionId]), [
      ['worker', 'low'], ['director', 'medium'], ['reviewer', 'high'],
    ]);
    const store = memoryStore();
    writeCollaborationDefault(store, 'host-a', result.collaboration);
    const restored = draftFromCollaboration(readCollaborationDefaults(store)['host-a']);
    assert.equal(restored.director?.thinkingOptionId, 'medium');
    assert.equal(restored.worker?.thinkingOptionId, 'low');
    assert.equal(restored.reviewer?.thinkingOptionId, 'high');
    draft.director.thinkingOptionId = null;
    assert.equal(snapshotFromDraft(draft).collaboration?.settings.profiles.find(profile => profile.id === 'director')?.thinkingOptionId, undefined);
    assert.equal(saved.settings.profiles[0].thinkingOptionId, 'high');
  });

  it('clears thinking when changing a model or provider, but keeps it when choosing the same model', () => {
    const draft = draftFromCollaboration(snapshot('full'));
    assert.ok(draft.worker);
    draft.worker.thinkingOptionId = 'high';
    const next = { provider: 'stub', model: 'work', providerLabel: 'Stub', modelLabel: 'Work' };
    draft.worker = selectRoleModel(draft.worker, next);
    assert.equal(draft.worker.thinkingOptionId, 'high');
    assert.equal(draft.worker.modeId, 'code');
    draft.worker = selectRoleModel(draft.worker, { ...next, model: 'other' });
    assert.equal(draft.worker.thinkingOptionId, null);
    assert.equal(draft.worker.modeId, null);
    assert.equal(snapshotFromDraft(draft).collaboration?.settings.profiles.find(profile => profile.id === 'worker')?.thinkingOptionId, undefined);
    draft.worker.thinkingOptionId = 'low';
    draft.worker = selectRoleModel(draft.worker, { ...next, provider: 'other' });
    assert.equal(draft.worker.thinkingOptionId, null);
  });

  it('clears an inherited permission mode and preserves verification argv exactly', () => {
    const saved = snapshot('full');
    saved.settings.verificationCommands[0].args = [' test name ', '', 'path with spaces'];
    const draft = draftFromCollaboration(saved);
    assert.equal(draft.worker?.modeId, 'code');
    assert.ok(draft.worker);
    draft.worker.modeId = null;
    const result = snapshotFromDraft(draft);
    assert.equal(result.error, null);
    assert.equal(result.collaboration?.settings.profiles.find(profile => profile.id === 'worker')?.modeId, undefined);
    assert.deepEqual(result.collaboration?.settings.verificationCommands[0].args, [' test name ', '', 'path with spaces']);
  });

  it('round-trips a saved snapshot, and execute + review uses the worker as the lead', () => {
    const rich = taskCollaborationSchema.parse({
      mode: 'full',
      settings: {
        profiles: [
          { id: 'director', label: 'Design', provider: 'stub/design', transport: 'mcp', instructions: 'Plan carefully.', modeId: 'plan', thinkingOptionId: 'high', featureValues: { temperature: 0.2 } },
          { id: 'worker', label: 'Work', provider: 'stub/work', transport: 'structured', modeId: 'code' },
          { id: 'reviewer', label: 'Review', provider: 'stub/review', transport: 'mcp' },
          { id: 'extra', label: 'Extra', provider: 'stub/extra', transport: 'mcp' },
        ],
        directorProfileId: 'director',
        workerProfileId: 'worker',
        reviewerProfileId: 'reviewer',
        rolePrompts: { plan: 'Plan the work.', execute: 'Keep existing behavior.', review: 'Check the diff.' },
        maxReworks: 1,
        maxAttempts: 12,
        turnTimeoutMs: 600_000,
        runTimeoutMs: 3_600_000,
        requirePlanApproval: true,
        allowDirectorSelection: true,
        verificationCommands: [{ label: 'test', command: 'npm', args: ['test'], timeoutMs: 60_000 }],
        categoryOverrides: { backend: 'worker' },
        taskOverrides: { docs: 'extra' },
      },
    });
    const once = snapshotFromDraft(draftFromCollaboration(rich));
    assert.equal(once.error, null);
    assert.deepEqual(canonical(once.collaboration as TaskCollaboration), canonical(rich));
    const twice = snapshotFromDraft(draftFromCollaboration(once.collaboration));
    assert.deepEqual(canonical(twice.collaboration as TaskCollaboration), canonical(once.collaboration as TaskCollaboration));

    const review = taskCollaborationSchema.parse({ mode: 'execute_review', settings: rich.settings });
    const reviewDraft = draftFromCollaboration(review);
    assert.ok(reviewDraft.director);
    const reviewSnap = snapshotFromDraft(reviewDraft);
    assert.equal(reviewSnap.error, null);
    assert.equal(reviewSnap.collaboration?.settings.directorProfileId, 'worker');
    assert.equal(reviewSnap.collaboration?.settings.workerProfileId, 'worker');
    assert.equal(reviewSnap.collaboration?.settings.reviewerProfileId, 'reviewer');
    assert.equal(reviewSnap.collaboration?.settings.profiles.some(profile => profile.id === 'director'), false);
    assert.equal(reviewSnap.collaboration?.settings.requirePlanApproval, true);

    reviewDraft.preserved.categoryOverrides.backend = reviewDraft.ids.director;
    const kept = snapshotFromDraft(reviewDraft);
    assert.equal(kept.error, null);
    assert.equal(kept.collaboration?.settings.directorProfileId, 'worker');
    assert.equal(kept.collaboration?.settings.categoryOverrides.backend, 'director');
    assert.equal(kept.collaboration?.settings.profiles.find(profile => profile.id === 'director')?.provider, 'stub/design');
  });

  it('requires a reviewer only for execute + review, and a lead for the full flow', () => {
    const full = draftFromCollaboration(taskCollaborationSchema.parse({ mode: 'full', settings: settingsOf(false) }));
    assert.equal(snapshotFromDraft(full).error, null);
    const missingReviewer = { ...full, mode: 'execute_review' as const, reviewer: null };
    const rejected = snapshotFromDraft(missingReviewer);
    assert.equal(rejected.error?.code, 'reviewer-required');
    assert.equal(rejected.collaboration, null);

    const leadIsWorker = collaborationSettingsSchema.parse({
      ...settingsOf(false),
      profiles: settingsOf(false).profiles.filter(profile => profile.id === 'worker'),
      directorProfileId: 'worker',
    });
    const noLead = draftFromCollaboration({ mode: 'full', settings: leadIsWorker });
    assert.equal(noLead.director?.provider, 'stub');
    assert.equal(snapshotFromDraft(noLead).error, null);
    noLead.director = null;
    assert.equal(snapshotFromDraft(noLead).error?.code, 'director-required');
  });

  it('inherits a saved snapshot over the catalog, and keeps Off off', () => {
    const saved = taskCollaborationSchema.parse({ mode: 'full', settings: settingsOf(true) });
    const catalogSettings = collaborationSettingsSchema.parse({
      ...settingsOf(false),
      maxReworks: 9,
      profiles: [
        { id: 'director', label: 'Other', provider: 'other/design', transport: 'mcp' },
        { id: 'worker', label: 'Other work', provider: 'other/work', transport: 'mcp' },
      ],
    });
    const inherited = inheritCollaborationDraft(saved, { settings: catalogSettings, rolePrompts: { plan: 'catalog plan' } });
    assert.equal(inherited.enabled, true);
    assert.equal(inherited.maxReworks, 1);
    assert.equal(inherited.worker?.provider, 'stub');
    inherited.maxReworks = 7;
    inherited.preserved.categoryOverrides.backend = 'reviewer';
    assert.equal(saved.settings.maxReworks, 1);
    assert.equal(saved.settings.categoryOverrides.backend, 'worker');

    const catalog = { settings: catalogSettings, rolePrompts: { plan: 'catalog plan', execute: 'catalog execute' } };
    for (const missing of [null, undefined]) {
      const off = inheritCollaborationDraft(missing, catalog);
      assert.equal(off.enabled, false);
      assert.equal(snapshotFromDraft(off).collaboration, null);
      const turnedOn = snapshotFromDraft({ ...off, enabled: true });
      assert.equal(turnedOn.error, null);
      assert.equal(turnedOn.collaboration?.settings.profiles.find(profile => profile.id === 'worker')?.provider, 'other/work');
    }

    const prompts = inheritCollaborationDraft(undefined, {
      settings: collaborationSettingsSchema.parse({ ...settingsOf(true), rolePrompts: { plan: 'from settings' } }),
      rolePrompts: { plan: 'catalog plan', execute: 'catalog execute' },
    });
    assert.equal(prompts.enabled, false);
    assert.equal(prompts.prompts.plan, 'from settings');
    assert.equal(prompts.prompts.execute, 'catalog execute');
    assert.equal(prompts.prompts.review, '');
  });

  it('stores one default per host and ignores a later edit of that default', () => {
    const store = memoryStore();
    const saved = taskCollaborationSchema.parse({ mode: 'full', settings: settingsOf(true) });
    writeCollaborationDefault(store, 'host-a', saved);
    writeCollaborationDefault(store, 'host-b', null);
    const map = readCollaborationDefaults(store);
    assert.deepEqual(canonical(map['host-a'] as TaskCollaboration), canonical(saved));
    assert.equal(map['host-b'], null);
    assert.equal(storedDefault(map, 'host-c'), undefined);
    assert.equal(storedDefault(map, 'host-b'), null);
    const cloned = JSON.parse(JSON.stringify(map['host-a'])) as TaskCollaboration;
    writeCollaborationDefault(store, 'host-a', null);
    assert.equal(cloned.settings.maxReworks, saved.settings.maxReworks);
    assert.equal(readCollaborationDefaults(store)['host-a'], null);

    store.setItem('paseo-todo.collaboration-defaults.v1', '{');
    assert.deepEqual(readCollaborationDefaults(store), {});
    store.setItem('paseo-todo.collaboration-defaults.v1', JSON.stringify({ 'host-a': { mode: 'nope' }, 'host-b': null, '': saved }));
    const parsed = readCollaborationDefaults(store);
    assert.equal(parsed['host-a'], undefined);
    assert.equal(parsed['host-b'], null);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, ''), false);
  });

  it('blocks an enabled draft when the host cannot apply it, without blocking Off', () => {
    const off = { enabled: false, mode: 'execute_review' as const };
    assert.equal(collaborationBlock(off, null), null);
    assert.equal(collaborationBlock({ enabled: true, mode: 'full' }, null)?.code, 'loading');
    assert.equal(collaborationBlock({ enabled: true, mode: 'full' }, { capabilities: { ...readyCapabilities, collaboration: false }, error: 'missing' })?.code, 'unavailable');
    assert.equal(collaborationBlock({ enabled: true, mode: 'execute_review' }, { capabilities: { ...readyCapabilities, executeReview: false }, error: null })?.code, 'execute-review');
    assert.equal(collaborationBlock({ enabled: true, mode: 'full' }, { capabilities: { ...readyCapabilities, inlineModels: false }, error: 'ignored' })?.code, 'inline-models');
    assert.equal(collaborationWarning(null), null);
    assert.equal(collaborationWarning({ capabilities: { ...readyCapabilities, collaboration: false }, error: 'missing' }), null);
    assert.equal(collaborationWarning({ capabilities: readyCapabilities, error: 'partial' }), 'partial');

    const draft = draftFromCollaboration(taskCollaborationSchema.parse({ mode: 'execute_review', settings: settingsOf(true) }));
    assert.ok(draft.director);
    draft.director = { ...draft.director, provider: 'other' };
    assert.deepEqual(foreignProviderIds(draft, ['stub']), []);
    assert.ok(draft.worker);
    draft.worker = { ...draft.worker, provider: 'other' };
    assert.deepEqual(foreignProviderIds(draft, ['stub']), ['other']);
    draft.worker = { ...draft.worker, provider: 'stub' };
    draft.mode = 'full';
    assert.deepEqual(foreignProviderIds(draft, ['stub']), ['other']);
  });

  it('describes running collaboration separately from todo review', () => {
    const collaboration = taskCollaborationSchema.parse({ mode: 'full', settings: settingsOf(true) });
    const base = { collaboration, collaborationPhase: 'executing', collaborationControl: 'running', collaborationAcceptance: null };
    assert.equal(collaborationStatus(base)?.title[0], 'Executing');
    assert.match(collaborationStatus(base)?.detail[0] ?? '', /does not finish/);
    const waiting = collaborationStatus({ ...base, collaborationPhase: 'awaiting_acceptance', collaborationControl: 'paused', collaborationAcceptance: 'pending' });
    assert.equal(waiting?.title[0], 'Waiting in the session');
    assert.match(waiting?.detail[0] ?? '', /before merging/);
    const accepted = collaborationStatus({ ...base, collaborationPhase: 'completed', collaborationControl: 'running', collaborationAcceptance: 'accepted' });
    assert.equal(accepted?.title[0], 'Accepted in the session');
    assert.match(accepted?.detail[0] ?? '', /binding/);
    const paused = collaborationStatus({ ...base, collaborationPhase: 'executing', collaborationControl: 'paused' });
    assert.match(paused?.detail[0] ?? '', /plan approval/);
    assert.doesNotMatch(paused?.detail[0] ?? '', /already approved/);
    for (const phase of ['planning', 'reviewing', 'final_review']) {
      const copy = collaborationStatus({ ...base, collaborationPhase: phase, collaborationControl: 'running' });
      assert.doesNotMatch(copy?.title[0] ?? '', /awaiting review/i);
      assert.match(copy?.detail[0] ?? '', /does not finish/);
    }
    assert.equal(collaborationStatus({ ...base, collaboration: null }), null);
  });

  it('keeps start blocked only for the task being edited, and builds new profiles as mcp', () => {
    assert.equal(collaborationEditBlocksStart(null, { hostId: 'a', id: '1' }), false);
    assert.equal(collaborationEditBlocksStart({ hostId: 'a', id: '1' }, { hostId: 'a', id: '2' }), false);
    assert.equal(collaborationEditBlocksStart({ hostId: 'b', id: '1' }, { hostId: 'a', id: '1' }), false);
    assert.equal(collaborationEditBlocksStart({ hostId: 'a', id: '1' }, { hostId: 'a', id: '1' }), true);

    const left = blankCollaborationDraft();
    const right = blankCollaborationDraft();
    assert.equal(sameCollaborationDraft(left, right), true);
    right.maxReworks = 4;
    assert.equal(sameCollaborationDraft(left, right), false);

    const draft = blankCollaborationDraft();
    draft.enabled = true;
    draft.director = { provider: 'stub', model: 'design', modeId: 'plan', providerLabel: 'Stub', modelLabel: 'Design' };
    draft.worker = { provider: 'stub', model: 'work', modeId: null, providerLabel: 'Stub', modelLabel: 'Work' };
    draft.prompts = { plan: 'Plan it', execute: 'Do it', review: 'Check it' };
    draft.requirePlanApproval = true;
    const snap = snapshotFromDraft(draft);
    assert.equal(snap.error, null);
    assert.equal(snap.collaboration?.settings.profiles.find(profile => profile.id === 'director')?.transport, 'mcp');
    assert.equal(snap.collaboration?.settings.profiles.find(profile => profile.id === 'worker')?.transport, 'mcp');
    assert.equal(snap.collaboration?.settings.profiles.find(profile => profile.id === 'director')?.modeId, 'plan');
    assert.equal(snap.collaboration?.settings.rolePrompts?.execute, 'Do it');
    assert.equal(snap.collaboration?.settings.requirePlanApproval, true);
  });
});
