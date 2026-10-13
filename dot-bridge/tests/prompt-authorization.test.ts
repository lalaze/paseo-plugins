import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BridgeStore } from '../server/store';
import { BridgeEngine } from '../server/engine';
import { withPromptAuthorization } from '../shared/prompt-authorization';
import { defaultSettings } from '../shared/settings';

const marker = '【本条任务的授权说明';
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-prompt-authorization-'));
  const store = await BridgeStore.open(dir);
  let enabled = false;
  const engine = new BridgeEngine({ store, getMaxInFlight: () => 2, getAppendTaskAuthorization: () => enabled });
  await engine.init();
  t.after(async () => { engine.dispose(); await store.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, engine, enable: (value: boolean) => { enabled = value; } };
}

test('authorization is opt-in, requires a bound workspace and preserves explicit restrictions', () => {
  assert.equal(defaultSettings.appendTaskAuthorization, false);
  assert.equal(withPromptAuthorization('只给方案，不改文件', '/repo', false), '只给方案，不改文件');
  assert.equal(withPromptAuthorization('hello', null, true), 'hello');
  const body = withPromptAuthorization('只给方案，不改文件', '/repo', true);
  assert.ok(body.startsWith('只给方案，不改文件\n\n'));
  assert.match(body, /只读、解释或仅设计的请求不授权写入/);
  assert.match(body, /不推翻我明确的限制、拒绝或取消/);
  assert.match(body, /Your dot \/ ChatGPT/);
  assert.match(body, /不是 ChatGPT 平台审批结果/);
  assert.match(body, /不换通道或自动重试绕过/);
  assert.throws(() => withPromptAuthorization('x'.repeat(20_000), '/repo', true), /原文未被截断/);
});

test('native prompts persist scope once; toggling the setting cannot rewrite replayed input or old messages', async t => {
  const h = await fixture(t);
  const input = { id: randomUUID(), operationId: randomUUID(), clientMessageId: randomUUID(), workspaceId: 'ws', cwd: h.dir, body: '实现当前功能', systemPrompt: '', attachments: [] };
  const original = await h.engine.providerPrompt(input);
  assert.equal(original.task.messages[0].body, input.body);
  h.enable(true);
  const replay = await h.engine.providerPrompt(input);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.task.messages, original.task.messages);
  const nextInput = { ...input, operationId: randomUUID(), clientMessageId: randomUUID(), body: '继续，仅修改相关测试' };
  const next = await h.engine.providerPrompt(nextInput);
  assert.equal(next.task.messages[0].body, input.body);
  assert.ok(next.task.messages.at(-1)!.body.includes(JSON.stringify(h.dir)));
  assert.equal(next.task.messages.at(-1)!.body.split(marker).length, 2);
  assert.equal(next.task.title, input.body);
  assert.deepEqual(next.task.permissions, [], 'A prompt note must not manufacture an approved permission');
  h.enable(false);
  const replayNext = await h.engine.providerPrompt(nextInput);
  assert.equal(replayNext.duplicate, true);
  assert.deepEqual(replayNext.task.messages, next.task.messages);
  const off = await h.engine.providerPrompt({ ...input, operationId: randomUUID(), clientMessageId: randomUUID(), body: '仅解释结果' });
  assert.equal(off.task.messages.at(-1)!.body, '仅解释结果');
  await h.store.load();
  assert.deepEqual(h.engine.task(input.id).messages, off.task.messages);
});

test('new native conversations and task-panel requests/follow-ups receive the same scoped note', async t => {
  const h = await fixture(t); h.enable(true);
  const native = await h.engine.providerPrompt({ id: randomUUID(), operationId: randomUUID(), clientMessageId: randomUUID(), workspaceId: 'ws', cwd: h.dir, body: '分析这段代码', systemPrompt: '', attachments: [] });
  assert.ok(native.task.messages[0].body.includes(marker));
  const input = { operationId: randomUUID(), workspaceId: 'ws', title: 'Panel task', requirement: '实现请求的功能', acceptance: '', mode: 'text' as const, repository: null, remoteName: null, baseSha: null, targetBranch: null, environmentHint: '', workspaceRoot: h.dir };
  const panel = await h.engine.createTask(input);
  assert.ok(panel.messages[0].body.includes(marker));
  const next = await h.engine.addMessage({ id: panel.id, revision: panel.revision, operationId: randomUUID(), body: '仅解释，不要修改', kind: 'answer' });
  assert.ok(next.messages.at(-1)!.body.startsWith('仅解释，不要修改\n\n'));
  assert.ok(next.messages.at(-1)!.body.includes(marker));
  const old = await h.engine.createTask({ ...input, operationId: randomUUID(), workspaceRoot: undefined });
  assert.equal(old.messages[0].body, input.requirement);
});

test('oversized authorization-wrapped messages fail atomically without consuming operation IDs', async t => {
  const h = await fixture(t); h.enable(true);
  const input = { id: randomUUID(), operationId: randomUUID(), clientMessageId: randomUUID(), workspaceId: 'ws', cwd: h.dir, body: 'x'.repeat(20_000), systemPrompt: '', attachments: [] };
  await assert.rejects(h.engine.providerPrompt(input), /原文未被截断/);
  assert.equal(h.engine.tasks().length, 0);
  assert.equal(h.store.read().dedup.operations[input.operationId], undefined);
  h.enable(false);
  const accepted = await h.engine.providerPrompt(input);
  assert.equal(accepted.task.messages[0].body, input.body);
});
