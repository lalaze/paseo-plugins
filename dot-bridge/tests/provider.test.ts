import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ProviderEvent, ProviderPersistence, ProviderPrompt, ProviderSessionConfig } from '@getpaseo/plugin/server/provider';
import { ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import { BridgeEngine } from '../server/engine';
import { createGit } from '../server/git';
import { BridgeStore } from '../server/store';
import { createDotProvider, promptContents, WORKSPACE_ENV } from '../server/provider';
import { withDispatch } from '../shared/machine';

const config: ProviderSessionConfig = { cwd: '/repo', env: { [WORKSPACE_ENV]: 'ws-test' }, mcpServers: {}, settings: {}, persist: true };
const prompt = (text: string, id: string = randomUUID()): ProviderPrompt => ({ clientMessageId: id, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text }] } });
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-provider-'));
  const store = await BridgeStore.open(dir);
  const engine = new BridgeEngine({ store, git: createGit({ cacheRoot: join(dir, 'git') }), getMaxInFlight: () => 2 });
  await engine.init();
  const lifecycle = new AbortController();
  const provider = createDotProvider({ engine: async () => engine, tick: async () => {}, signal: lifecycle.signal, pollMs: 5 });
  const events: ProviderEvent[] = [];
  const connect = async () => {
    const connection = await provider.connect({ versions: [1], capabilities: ['prompt.message', 'prompt.image', 'session.persistence', 'timeline.plugin'] });
    connection.onEvent(event => { ProviderEventSchema.parse(event); events.push(event); });
    return connection;
  };
  t.after(async () => { lifecycle.abort(); engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); });
  const connection = await connect();
  const openSession = async (sid = 'chat', persistence?: ProviderPersistence) => {
    await connection.send({ type: 'session.open', requestId: randomUUID(), sessionId: sid, config, history: 'replay', persistence });
  };
  const claim = async () => {
    let task = engine.tasks()[0]!;
    if (task.status === 'queued') await store.mutate(draft => { draft.tasks[0] = withDispatch(draft.tasks[0]!, Date.now()); });
    task = engine.task(task.id);
    await engine.claimTask({ taskId: task.id, roundId: task.currentRoundId, connectionId: engine.connection().id });
    return engine.task(task.id);
  };
  const result = async (summary: string) => {
    const task = await claim();
    await engine.processResult({ taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId, updateId: randomUUID(), kind: 'text', baseSha: null, headSha: null, branch: null, prUrl: null, summary, checks: [], processedThroughSeq: task.userMessageSeq });
  };
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'Expected provider event did not arrive');
  };
  return { dir, store, engine, connection, connect, openSession, claim, result, events, wait };
}

test('native chat replies, automatically advances rounds, and replays without duplicate work', async t => {
  const h = await fixture(t); await h.openSession();
  const first = prompt('Remember apple');
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: first });
  assert.equal(h.engine.tasks().length, 1);
  await h.result('I remember apple');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.ok(h.events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'I remember apple'));
  // Re-delivery is acknowledged, without starting another round or duplicating the user message.
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: first });
  assert.equal(h.engine.tasks()[0]!.rounds.length, 1);
  assert.equal(h.engine.tasks()[0]!.messages.filter(m => m.author === 'user').length, 1);
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('What did I say?') });
  assert.equal(h.engine.tasks()[0]!.rounds.length, 2);
  assert.equal(h.engine.tasks()[0]!.messages.at(-1)!.body, 'What did I say?');
  await h.result('apple');
  await h.wait(() => h.events.filter(e => e.type === 'session.turn' && e.state === 'completed').length === 2);
  const opened = h.events.find(e => e.type === 'session.opened');
  assert.ok(opened?.type === 'session.opened');
  await h.connection.close();
  const restored = await h.connect(); const start = h.events.length;
  await restored.send({ type: 'session.open', sessionId: 'restored', requestId: randomUUID(), config, history: 'replay', persistence: opened.persistence });
  const texts = h.events.slice(start).flatMap(e => e.type === 'timeline.item' && (e.item.type === 'user_message' || e.item.type === 'assistant_message') ? [e.item.text] : []);
  assert.deepEqual(texts, ['Remember apple', 'I remember apple', 'What did I say?', 'apple']);
  assert.equal(h.engine.tasks().length, 1);
});

test('waiting_user allows an answer in the same round; cancel waits for remote acknowledgment', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Plan a trip') });
  const task = await h.claim();
  await h.engine.reportProgress({ taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId, updateId: randomUUID(), kind: 'waiting_user', note: 'Which city?', processedThroughSeq: task.userMessageSeq });
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Boston') });
  assert.equal(h.engine.tasks()[0]!.rounds.length, 1);
  assert.equal(h.engine.tasks()[0]!.messages.at(-1)!.kind, 'answer');
  await h.connection.send({ type: 'session.interrupt', sessionId: 'chat', requestId: randomUUID() });
  assert.equal(h.engine.tasks()[0]!.rounds[0]!.stop.requested, true);
  assert.notEqual(h.engine.tasks()[0]!.status, 'stopped');
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Next') });
  assert.ok(h.events.some(e => e.type === 'session.prompt_result' && e.result.type === 'failed'));
  const latest = h.engine.task(task.id);
  await h.engine.reportProgress({ taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId, updateId: randomUUID(), kind: 'stopped', note: 'Stopped', processedThroughSeq: latest.userMessageSeq });
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Try again') });
  assert.equal(h.engine.tasks()[0]!.rounds.length, 2);
  assert.equal(h.engine.tasks()[0]!.status, 'queued');
});

test('progress is visible before completion, updates the status card, and survives replay without duplicates', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Compare the options') });
  const task = await h.claim();
  const report = { taskId: task.id, roundId: task.currentRoundId, connectionId: task.connectionId, updateId: randomUUID(), kind: 'running' as const, note: 'Option A supports offline use; checking the remaining trade-offs.', processedThroughSeq: task.userMessageSeq };
  await h.engine.reportProgress(report);
  const progressEvents = () => h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === report.note);
  await h.wait(() => progressEvents().length === 1);
  assert.equal(h.engine.task(task.id).status, 'running');
  assert.ok(!h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.ok(h.events.some(e => e.type === 'timeline.item' && e.item.type === 'tool_call' && e.item.status === 'running' && e.item.detail.type === 'plain_text' && e.item.detail.label === report.note));
  await h.engine.reportProgress(report);
  await h.result('Choose A for offline use.');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  assert.equal(progressEvents().length, 1);
  const opened = h.events.find(e => e.type === 'session.opened'); assert.ok(opened?.type === 'session.opened');
  await h.connection.close(); const restored = await h.connect(); const start = h.events.length;
  await restored.send({ type: 'session.open', sessionId: 'replay', requestId: randomUUID(), config, history: 'replay', persistence: opened.persistence });
  assert.deepEqual(h.events.slice(start).flatMap(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' ? [e.item.text] : []), [report.note, 'Choose A for offline use.']);
  await restored.send({ type: 'session.prompt', sessionId: 'replay', prompt: prompt('Now compare cost') });
  const card = h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'tool_call').at(-1);
  assert.ok(card?.type === 'timeline.item' && card.item.type === 'tool_call' && card.item.detail.type === 'plain_text');
  assert.notEqual(card.item.detail.label, report.note, 'Do not reuse previous-round progress for a new prompt');
});

test('files are attached atomically, recover from disk, and invalid files create no task', async t => {
  const h = await fixture(t); await h.openSession();
  const path = join(h.dir, 'sample.txt'); await writeFile(path, 'synthetic attachment');
  const message = prompt('Read the file');
  assert.equal(message.input.type, 'message');
  if (message.input.type !== 'message') return;
  message.input.content.push({ type: 'uploaded_file', id: 'upload', fileName: 'sample.txt', mimeType: 'text/plain', size: 20, path });
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: message });
  const task = h.engine.tasks()[0]!;
  assert.equal(task.attachments.length, 1);
  assert.equal((await h.engine.readAttachment(task.id, task.attachments[0]!.id)).content, 'synthetic attachment');
  assert.ok(h.events.some(e => e.type === 'timeline.item' && e.item.type === 'plugin'));
  await h.connection.close(); await h.store.dispose();
  const reopened = await BridgeStore.open(h.dir);
  assert.equal(reopened.read().tasks[0]!.provider?.clientMessageIds['1'], message.clientMessageId);
  await reopened.dispose();
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(promptContents(message), /1 MiB/);
});

test('concurrent prompt and interrupt cannot leave newly submitted work running', async t => {
  const h = await fixture(t); await h.openSession();
  await Promise.all([
    h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('queued') }),
    h.connection.send({ type: 'session.interrupt', sessionId: 'chat', requestId: randomUUID() }),
  ]);
  assert.equal(h.engine.tasks()[0]!.status, 'stopped');
});

test('reconnect to active work resumes waiting without re-dispatching; workspace mismatch fails', async t => {
  const h = await fixture(t); await h.openSession();
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Long work') });
  const opened = h.events.find(e => e.type === 'session.opened'); assert.ok(opened?.type === 'session.opened');
  await h.connection.close(); const restored = await h.connect();
  await restored.send({ type: 'session.open', sessionId: 'again', requestId: randomUUID(), config, history: 'replay', persistence: opened.persistence });
  assert.ok(h.events.some(e => e.type === 'session.turn' && e.sessionId === 'again' && e.state === 'started'));
  assert.equal(h.engine.tasks()[0]!.messages.length, 1);
  await restored.send({ type: 'session.open', sessionId: 'wrong', requestId: 'wrong', config: { ...config, cwd: '/other' }, history: 'replay', persistence: opened.persistence });
  assert.ok(h.events.some(e => e.type === 'request.failed' && e.requestId === 'wrong'));
  await h.result('Done after reconnect');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.sessionId === 'again' && e.state === 'completed'));
});

test('reused client identity with changed text is rejected without changing stored conversation', async t => {
  const h = await fixture(t); await h.openSession();
  const original = prompt('Original');
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: original });
  await h.result('Done');
  await h.wait(() => h.events.some(e => e.type === 'session.turn' && e.state === 'completed'));
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: prompt('Changed', original.clientMessageId) });
  assert.equal(h.engine.tasks()[0]!.rounds.length, 1);
  assert.equal(h.engine.tasks()[0]!.messages[0]!.body, 'Original');
  assert.ok(h.events.some(e => e.type === 'session.prompt_result' && e.result.type === 'failed'));
});

test('persistence refuses a missing committed task and invalid file input leaves no partial task', async t => {
  const h = await fixture(t);
  await h.connection.send({ type: 'session.open', sessionId: 'lost', requestId: 'lost', config, history: 'replay', persistence: { version: 1, data: { taskId: randomUUID(), cwd: config.cwd, workspaceId: 'ws-test', taskCreated: true } } });
  assert.ok(h.events.some(e => e.type === 'request.failed' && e.requestId === 'lost'));
  await h.openSession();
  const message = prompt('bad file');
  if (message.input.type !== 'message') return;
  message.input.content.push({ type: 'image', mimeType: 'image/png', data: 'invalid' });
  await h.connection.send({ type: 'session.prompt', sessionId: 'chat', prompt: message });
  assert.equal(h.engine.tasks().length, 0);
});
