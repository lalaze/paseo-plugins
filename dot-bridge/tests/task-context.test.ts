import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { createTask, appendUserMessage, appendDotMessage } from '../shared/machine';
import { permissionSchema } from '../shared/permissions';
import { taskContext, taskStatus, taskHistoryPage, CONTEXT_PAGE_CHARS } from '../server/task-context';
import { BridgeEngine } from '../server/engine';
import { BridgeStore } from '../server/store';
import { createMcpServer } from '../server/mcp-server';
import { attachmentPage, taskPanelSchema, taskPanelView } from '../shared/attachment-pages';
import { taskAttachmentList } from '../shared/rpc';

test('attachment archives page losslessly while working/UI views contain only recent files', () => {
  const task = historyTask();
  task.attachments = Array.from({ length: 37 }, (_, i) => ({ id: randomUUID(), roundId: task.currentRoundId,
    name: `image-${i}.png`, mediaType: 'image/png', size: 100 + i, sha256: 'a'.repeat(64), author: 'dot' as const, createdAt: i }));
  const original = structuredClone(task);
  const context = taskContext(task);
  assert.deepEqual(context.task.attachments, task.attachments.slice(-8));
  assert.equal(context.context.attachments.total, 37);
  assert.equal(context.context.attachments.totalBytes, task.attachments.reduce((n, a) => n + a.size, 0));
  assert.equal(context.context.attachments.hasOlder, true);
  const panel = taskPanelSchema.parse(taskPanelView(task));
  assert.equal(panel.attachments.length, 8);
  assert.equal(panel.attachmentSummary.total, 37);

  const history = [];
  let historyCursor: string | null = null;
  do {
    const page = taskHistoryPage(task, { section: 'attachments', roundId: task.currentRoundId, cursor: historyCursor });
    history.push(...page.entries.map(entry => { assert.ok('value' in entry); return entry.value; }));
    historyCursor = page.nextCursor;
  } while (historyCursor);
  assert.deepEqual(history, original.attachments);

  const first = taskAttachmentList.output.parse(attachmentPage(task));
  const collected = [...first.attachments];
  let cursor = first.nextCursor;
  // New uploads and progress during browsing must not duplicate or skip older records.
  task.attachments.push({ ...task.attachments[0]!, id: randomUUID() }); task.revision++;
  while (cursor) {
    const page = taskAttachmentList.output.parse(attachmentPage(task, cursor));
    collected.push(...page.attachments); cursor = page.nextCursor;
  }
  assert.deepEqual(collected, [...original.attachments].reverse());
  assert.throws(() => attachmentPage({ ...task, id: randomUUID() }, first.nextCursor), /cursor/);
  assert.throws(() => attachmentPage(task, `${task.id}:${randomUUID()}`), /cursor/);
  assert.throws(() => attachmentPage(task, ''), /cursor/);
  assert.deepEqual(attachmentPage({ ...task, attachments: [] }), { attachments: [], total: 0, totalBytes: 0, nextCursor: null });
  assert.equal(task.attachments.length, 38); // Projecting the view never trims storage.
});

function historyTask() {
  let task = createTask({ id: randomUUID(), connectionId: 'a'.repeat(32), workspaceId: 'ws',
    mode: 'text', repository: null, remoteName: null, branch: null, baseSha: null, targetBranch: null,
    title: 'Long task', requirement: 'Never modify my save files.', acceptance: '', environmentHint: '', roundId: randomUUID(), at: 1 });
  for (let i = 0; i < 60; i++) {
    task = appendDotMessage(task, task.currentRoundId, 'progress', `Old progress ${i}: ${'x'.repeat(1500)}`, i + 2, randomUUID());
    if (i % 10 === 0) task = appendUserMessage(task, `Requirement ${i}`, 'requirement', i + 2);
  }
  task = appendUserMessage(task, 'Only inspect the latest image.', 'requirement', 100);
  task.permissions.push(permissionSchema.parse({ requestId: randomUUID(), roundId: randomUUID(), userMessageSeq: 1,
    title: 'Denied edit', description: 'Do not write this file', requestedAt: 1, status: 'denied',
    scope: { toolName: 'apply_dot_changes', action: 'edit', targets: ['save.json'] } }));
  task.rounds[0]!.stop = { requested: true, at: 100, reported: false, reportedAt: null, localClosedAt: null, note: 'Stop now' };
  return task;
}

test('working context preserves user instructions and exact safety state without replaying the archive', () => {
  const task = historyTask(), before = structuredClone(task);
  const result = taskContext(task);
  assert.ok(result.task.messages.length <= 8);
  assert.equal(result.task.messages.at(-1)!.body, 'Only inspect the latest image.');
  assert.deepEqual(result.task.permissions, task.permissions);
  assert.deepEqual(result.task.rounds[0]!.stop, task.rounds[0]!.stop);
  const users = result.context.userInstructions!.entries.map(e => 'value' in e ? e.value : null);
  assert.deepEqual(users, task.messages.filter(m => m.author === 'user'));
  assert.equal(result.context.userInstructions!.nextCursor, null);
  assert.equal(result.context.messagePage.hasOlder, true);
  assert.ok(JSON.stringify(result).length < JSON.stringify(task).length / 3);
  assert.deepEqual(task, before);
  const status = taskStatus(task);
  assert.equal(status.permissions[0]!.status, 'denied');
  assert.deepEqual(status.stop, task.rounds[0]!.stop);
  assert.ok(!JSON.stringify(status).includes('Old progress'));
});

test('incremental messages page forward without gaps and reject an impossible sequence', () => {
  const task = historyTask(); let afterSeq = 1;
  const collected = [];
  do {
    const page = taskContext(task, afterSeq);
    collected.push(...page.task.messages);
    assert.ok(page.context.messagePage.nextAfterSeq > afterSeq);
    afterSeq = page.context.messagePage.nextAfterSeq;
    if (!page.context.messagePage.hasMore) break;
  } while (true);
  assert.deepEqual(collected, task.messages.filter(m => m.seq > 1));
  assert.deepEqual(taskContext(task, task.messageSeq).task.messages, []);
  assert.equal(taskContext(task, task.messageSeq).context.userInstructions, null);
  assert.throws(() => taskContext(task, task.messageSeq + 1), /afterSeq/);
});

test('long user instruction history is explicitly incomplete until every exact page is read', () => {
  let task = historyTask();
  for (let i = 0; i < 45; i++) task = appendUserMessage(task, `Constraint ${i}: ${'retain this restriction '.repeat(100)}`, 'requirement', 200 + i);
  const view = taskContext(task); let page = view.context.userInstructions!;
  assert.ok(page.nextCursor);
  const messages = [];
  do {
    for (const entry of page.entries) { assert.ok('value' in entry); messages.push(entry.value); }
    if (!page.nextCursor) break;
    page = taskHistoryPage(task, { section: 'user_messages', cursor: page.nextCursor });
  } while (true);
  assert.deepEqual(messages, task.messages.filter(m => m.author === 'user'));
});

test('current decisions and latest cross-round tool restrictions are retained with exact scopes', () => {
  const task = historyTask(), oldDenied = task.permissions[0]!;
  const current = permissionSchema.parse({ ...oldDenied, requestId: randomUUID(), roundId: task.currentRoundId,
    status: 'pending', scope: { toolName: 'run_dot_command', action: 'test', targets: ['/'] },
    platformBlock: { reason: 'Platform blocked this operation', at: 20 } });
  const oldRead = permissionSchema.parse({ ...oldDenied, requestId: randomUUID(), status: 'expired',
    scope: { toolName: 'read_dot_file', action: 'read', targets: ['private.ts'] } });
  task.permissions.push(current, oldRead);
  assert.deepEqual(taskContext(task).task.permissions, task.permissions);
  assert.deepEqual(taskStatus(task).permissions.find(p => p.requestId === current.requestId)!.platformBlock, current.platformBlock);
});

test('full history pages and oversized records are lossless and bound to task, revision and filter', () => {
  const task = historyTask();
  task.rounds[0]!.progressHistory = Array.from({ length: 30 }, (_, i) => ({ updateId: String(i), kind: 'running', note: '😀'.repeat(3000), processedThroughSeq: 1, at: i }));
  let page = taskHistoryPage(task, { section: 'rounds', limit: 1 });
  const chunks: string[] = [];
  const firstCursor = page.nextCursor;
  do {
    for (const e of page.entries) {
      assert.ok('jsonFragment' in e); assert.ok(e.jsonFragment.length <= CONTEXT_PAGE_CHARS); chunks.push(e.jsonFragment);
    }
    if (!page.nextCursor) break;
    page = taskHistoryPage(task, { section: 'rounds', limit: 1, cursor: page.nextCursor });
  } while (true);
  assert.deepEqual(JSON.parse(chunks.join('')), task.rounds[0]);
  assert.throws(() => taskHistoryPage({ ...task, id: randomUUID() }, { section: 'rounds', cursor: firstCursor }), /another task/);
  assert.throws(() => taskHistoryPage({ ...task, revision: task.revision + 1 }, { section: 'rounds', cursor: firstCursor }), /revision-conflict/);
  assert.throws(() => taskHistoryPage(task, { section: 'messages', cursor: firstCursor }), /another task/);
  assert.throws(() => taskHistoryPage(task, { section: 'messages', cursor: 'invalid' }), /Invalid history cursor/);
  const messages = []; let cursor: string | null = null;
  do {
    const part = taskHistoryPage(task, { section: 'messages', cursor, limit: 3 });
    for (const e of part.entries) { assert.ok('value' in e); messages.push(e.value); }
    cursor = part.nextCursor;
  } while (cursor);
  assert.deepEqual(messages, task.messages);
});

test('history filters an uncertain write receipt by operation ID instead of inferring from the recent index', () => {
  const task = historyTask(), operationId = randomUUID();
  task.localChanges = Array.from({ length: 10 }, (_, i) => ({ operationId: i === 0 ? operationId : randomUUID(),
    roundId: task.currentRoundId, status: 'applied', files: [], conflicts: [], at: i }));
  const view = taskContext(task);
  assert.equal(view.context.recentChanges.some(c => c.operationId === operationId), false);
  const history = taskHistoryPage(task, { section: 'changes', operationId });
  assert.equal(history.entries.length, 1);
  assert.ok('value' in history.entries[0]!);
  assert.deepEqual(history.entries[0].value, task.localChanges[0]);
});

async function mcpFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-context-')), store = await BridgeStore.open(dir);
  const engine = new BridgeEngine({ store, getMaxInFlight: () => 2 }); await engine.init();
  const task = historyTask(); task.connectionId = engine.connection().id;
  await store.mutate(d => { d.tasks.push(task); });
  const server = createMcpServer({ engine, host: '127.0.0.1', port: 0, getToken: () => engine.mcpToken() });
  const { endpoint } = await server.start();
  t.after(async () => { await server.stop(); engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); });
  const call = async (name: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${engine.mcpToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { connectionId: task.connectionId, taskId: task.id, ...extra } } }) });
    const data = await response.json();
    return data.error ? { error: data.error } : JSON.parse(data.result.content[0].text);
  };
  return { task, engine, call };
}

test('MCP default is compact; status and incremental reads reuse versioned guidance and protect connection scope', async t => {
  const h = await mcpFixture(t);
  const full = await h.call('get_dot_task');
  assert.equal(full.context.view, 'working-context');
  assert.match(full.localFileInstructions, /262144/);
  assert.equal(full.instructionsIncluded, true);
  const status = await h.call('get_dot_task_status');
  assert.equal(status.status, h.task.status); assert.equal(status.guidanceVersion, full.guidanceVersion);
  assert.equal(status.localFileInstructions, undefined);
  const increment = await h.call('get_dot_task', { afterSeq: h.task.messageSeq, knownGuidanceVersion: full.guidanceVersion });
  assert.equal(increment.instructionsIncluded, false);
  assert.equal(increment.localFileInstructions, undefined);
  assert.deepEqual(increment.task.messages, []);
  assert.equal((await h.call('get_dot_task', { knownGuidanceVersion: 'outdated' })).instructionsIncluded, true);
  for (const name of ['get_dot_task', 'get_dot_task_status', 'get_dot_task_history']) {
    assert.ok((await h.call(name, { connectionId: 'f'.repeat(32), ...(name === 'get_dot_task_history' ? { section: 'messages' } : {}) })).error);
  }
  const page = await h.call('get_dot_task_history', { section: 'user_messages' });
  assert.equal(page.total, h.task.messages.filter(m => m.author === 'user').length);
  for (let i = 0; i < 17; i++) {
    const current = h.engine.task(h.task.id);
    await h.engine.uploadAttachment({ id: current.id, roundId: current.currentRoundId, revision: current.revision,
      actor: 'user', operationId: randomUUID(), name: `file-${i}.txt`, mediaType: 'text/plain', encoding: 'utf8', content: `file ${i}` });
  }
  const attachments = await h.call('get_dot_task');
  assert.equal(attachments.task.attachments.length, 8);
  assert.equal(attachments.context.attachments.total, 17);
  const archive = [];
  let cursor = null;
  do {
    const result = await h.call('get_dot_task_history', { section: 'attachments', cursor });
    assert.equal(result.error, undefined);
    archive.push(...result.entries.map((entry: { value: unknown }) => entry.value));
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(archive, h.engine.task(h.task.id).attachments);
});
