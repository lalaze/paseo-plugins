import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function client(dir) {
  const child = spawn(process.execPath, [join(ROOT, 'hub.mjs'), 'run'], { env: { ...process.env, AGY_HUB_BIN: join(dir, 'fake-hub'), AGY_HUB_STATE_DIR: join(dir, 'state'), HUB_FIXTURE_LOG: join(dir, 'rpc.jsonl') }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(), queue = [], waiters = [], notifications = []; let counter = 0;
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'session/update') notifications.push(msg.params);
    else if (msg.method === 'session/request_permission') { const next = waiters.shift(); next ? next(msg) : queue.push(msg); }
    else if (pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  });
  return {
    child, send, notifications,
    request: (method, params) => new Promise((resolve, reject) => { const id = ++counter; pending.set(id, { resolve, reject }); send({ id, method, params }); }),
    permission: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve)),
    close: async () => { const exited = once(child, 'exit'); child.stdin.end(); await exited; },
  };
}

test('Hub ACP forwards only explicit once-approval, rejects malformed decisions, cancels, resumes and reports errors', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-acp-test-'));
  copyFileSync(join(ROOT, 'test/fixtures/hub-server.mjs'), join(dir, 'fake-hub')); chmodSync(join(dir, 'fake-hub'), 0o700);
  writeFileSync(join(dir, 'rpc.jsonl'), '');
  let c = client(dir);
  const rpcLog = () => readFileSync(join(dir, 'rpc.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  try {
    const initialized = await c.request('initialize', { protocolVersion: 1 });
    assert.equal(initialized.agentCapabilities.promptCapabilities.image, true);
    await assert.rejects(c.request('session/new', { cwd: dir, mcpServers: [{ name: 'unsupported' }] }), /MCP/);
    const injected = [{ name: 'paseo', command: 'node', args: ['fixture.mjs'], env: [{ name: 'TOKEN', value: 'initial' }] }];
    const session = await c.request('session/new', { cwd: dir, mcpServers: injected });
    const sid = session.sessionId;
    assert.equal(session.modes.currentModeId, 'default');
    assert.deepEqual(session.modes.availableModes.map(m => m.id), ['default', 'plan']);
    assert.deepEqual(initialized.agentCapabilities.mcpCapabilities, { http: true, sse: true });
    const rendering = await c.request('session/new', { cwd: dir, mcpServers: [] });
    await c.request('session/prompt', { sessionId: rendering.sessionId, prompt: [{ type: 'text', text: 'rendering' }] });
    const rendered = c.notifications.filter(n => n.sessionId === rendering.sessionId).map(n => n.update);
    assert.equal(rendered.filter(n => n.sessionUpdate === 'agent_message_chunk').map(n => n.content.text).join(''), 'Result:\n````diff\n@@ -1 +1,2 @@\n ```\n+added\n````');
    const shell = rendered.find(n => n.toolCallId === 'render-tool');
    assert.equal(shell.rawInput.command, 'git diff');
    assert.equal(shell.rawInput.cwd, '/fixture');
    assert.equal(shell.content[0].content.text, '@@ -1 +1,2 @@\n ```\n+added\n');
    assert.equal(shell.rawOutput.exitCode, 0);
    const prompt = text => c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] });
    await assert.rejects(c.request('session/set_mode', { sessionId: sid, modeId: 'bypass' }), /Unknown session mode/);
    await assert.rejects(c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'image', data: '' }] }), /MIME/);
    await c.request('session/prompt', {sessionId:sid,prompt:[{type:'text',text:'image'},{type:'image',mimeType:'image/png',data:'YQ=='}]});
    const imageRequest = rpcLog().find(x => x.method === 'SendUserCascadeMessage' && x.body.cascadeId === sid);
    assert.deepEqual(imageRequest.body.media, [{mimeType:'image/png',inlineData:'YQ=='}]);
    assert.equal(imageRequest.body.customAgentSpec.builtinAgent.customizationDiscovery.mcp.servers[0].env.TOKEN, 'initial');
    assert.ok(!readFileSync(join(dir, 'state', `${sid}.json`), 'utf8').includes('TOKEN'));
    const allowed = prompt('permission'); const permission = await c.permission();
    assert.equal(permission.params.toolCall.rawInput.CommandLine, 'printf fixture');
    assert.equal(rpcLog().some(x => x.method === 'HandleCascadeUserInteraction'), false);
    c.send({ id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
    assert.deepEqual(await allowed, { stopReason: 'end_turn' });
    assert.deepEqual(rpcLog().find(x => x.decision).decision, { allow: true, scope: 'PERMISSION_SCOPE_ONCE' });
    // Fresh sessions avoid reusing fixture step IDs and exercise both denial variants.
    for (const outcome of [{ outcome: 'selected', optionId: 'reject_once' }, { outcome: 'selected', optionId: 'allow_always' }]) {
      const s = await c.request('session/new', { cwd: dir, mcpServers: [] });
      const running = c.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'permission' }] });
      const request = await c.permission(); c.send({ id: request.id, result: { outcome } });
      await running;
      assert.equal(rpcLog().filter(x => x.decision).at(-1).decision.allow, false);
    }
    const cancelSession = await c.request('session/new', { cwd: dir, mcpServers: [] });
    const cancelled = c.request('session/prompt', { sessionId: cancelSession.sessionId, prompt: [{ type: 'text', text: 'permission' }] });
    await c.permission(); c.send({ method: 'session/cancel', params: { sessionId: cancelSession.sessionId } });
    assert.deepEqual(await cancelled, { stopReason: 'cancelled' });
    assert.ok(rpcLog().some(x => x.cancelled === cancelSession.sessionId));
    await c.close(); c = client(dir);
    await c.request('initialize', { protocolVersion: 1 });
    await c.request('session/load', { sessionId: sid, cwd: dir, mcpServers: [{type:'http',name:'paseo',url:'http://127.0.0.1:1234/mcp',headers:[{name:'Authorization',value:'rotated'}]}] });
    const replayed = c.notifications.filter(n => n.sessionId === sid).map(n => n.update);
    assert.equal(replayed.find(n => n.sessionUpdate === 'user_message_chunk')?.content.text, 'prior user');
    assert.equal(replayed.find(n => n.sessionUpdate === 'agent_message_chunk')?.content.text, 'prior assistant');
    assert.deepEqual(await prompt('hello'), { stopReason: 'end_turn' });
    const resumed = rpcLog().filter(x => x.method === 'SendUserCascadeMessage').at(-1).body.customAgentSpec.builtinAgent.customizationDiscovery.mcp.servers;
    assert.equal(resumed[0].headers.Authorization, 'rotated');
    await assert.rejects(prompt('error'), /fixture execution failed/);
  } finally { await c.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Hub ACP plan mode shows Proceed, starts execution, and restores the saved mode', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-acp-plan-'));
  copyFileSync(join(ROOT, 'test/fixtures/hub-server.mjs'), join(dir, 'fake-hub')); chmodSync(join(dir, 'fake-hub'), 0o700);
  writeFileSync(join(dir, 'rpc.jsonl'), '');
  const c = client(dir);
  const rpcLog = () => readFileSync(join(dir, 'rpc.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  try {
    await c.request('initialize', { protocolVersion: 1 });
    const session = await c.request('session/new', { cwd: dir, mcpServers: [] });
    await c.request('session/set_mode', { sessionId: session.sessionId, modeId: 'plan' });
    assert.equal(JSON.parse(readFileSync(join(dir, 'state', `${session.sessionId}.json`), 'utf8')).mode, 'plan');
    const running = c.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'plan-turn' }] });
    const proceed = await c.permission();
    assert.equal(proceed.params.toolCall.kind, 'switch_mode');
    assert.equal(proceed.params.toolCall.title, 'Review the implementation plan');
    assert.match(proceed.params.toolCall.content[0].content.text, /Inspect the renderer/);
    assert.deepEqual(proceed.params.options.map(o => o.optionId), ['default', 'plan']);
    const updates = c.notifications.filter(n => n.sessionId === session.sessionId).map(n => n.update);
    assert.equal(updates.find(n => n.toolCallId === 'ls-tool')?.kind, 'execute');
    assert.equal(updates.find(n => n.toolCallId === 'view-tool')?.kind, 'read');
    assert.equal(updates.find(n => n.toolCallId === 'grep-tool')?.kind, 'search');
    assert.equal(updates.find(n => n.toolCallId === 'plan-file')?.kind, 'think');
    assert.ok(updates.some(n => n.sessionUpdate === 'plan' && n.entries.some(e => e.content === 'Inspect the renderer')));
    const injected = rpcLog().filter(x => x.method === 'SendUserCascadeMessage').at(-1).body.items.map(i => i.text).join('\n');
    assert.match(injected, /PLANNING MODE/);
    c.send({ id: proceed.id, result: { outcome: { outcome: 'selected', optionId: 'default' } } });
    assert.deepEqual(await running, { stopReason: 'end_turn' });
    const after = c.notifications.filter(n => n.sessionId === session.sessionId).map(n => n.update);
    assert.equal(after.find(n => n.sessionUpdate === 'current_mode_update')?.currentModeId, 'default');
    assert.match(after.filter(n => n.sessionUpdate === 'agent_message_chunk').map(n => n.content.text).join(''), /implementing/);
    const sent = rpcLog().filter(x => x.method === 'SendUserCascadeMessage').map(x => x.body.items.map(i => i.text).join('\n'));
    assert.ok(sent.some(text => /approved the implementation plan/i.test(text)));
    assert.equal(JSON.parse(readFileSync(join(dir, 'state', `${session.sessionId}.json`), 'utf8')).mode, 'default');

    const stay = await c.request('session/new', { cwd: dir, mcpServers: [] });
    await c.request('session/set_mode', { sessionId: stay.sessionId, modeId: 'plan' });
    const staying = c.request('session/prompt', { sessionId: stay.sessionId, prompt: [{ type: 'text', text: 'plan-turn' }] });
    const reject = await c.permission();
    c.send({ id: reject.id, result: { outcome: { outcome: 'selected', optionId: 'plan' } } });
    assert.deepEqual(await staying, { stopReason: 'end_turn' });
    assert.equal(JSON.parse(readFileSync(join(dir, 'state', `${stay.sessionId}.json`), 'utf8')).mode, 'plan');
    const confirmed = await c.request('session/prompt', { sessionId: stay.sessionId, prompt: [{ type: 'text', text: '确认' }] });
    assert.deepEqual(confirmed, { stopReason: 'end_turn' });
    assert.equal(JSON.parse(readFileSync(join(dir, 'state', `${stay.sessionId}.json`), 'utf8')).mode, 'default');
    const confirmText = rpcLog().filter(x => x.method === 'SendUserCascadeMessage' && x.body.cascadeId === stay.sessionId).at(-1).body.items.map(i => i.text).join('\n');
    assert.match(confirmText, /approved the implementation plan/);
    assert.doesNotMatch(confirmText, /PLANNING MODE/);

    const approval = await c.request('session/new', { cwd: dir, mcpServers: [] });
    const waiting = c.request('session/prompt', { sessionId: approval.sessionId, prompt: [{ type: 'text', text: 'approval' }] });
    const review = await c.permission();
    assert.equal(review.params.toolCall.kind, 'switch_mode');
    c.send({ id: review.id, result: { outcome: { outcome: 'selected', optionId: 'default' } } });
    assert.deepEqual(await waiting, { stopReason: 'end_turn' });
    assert.equal(rpcLog().filter(x => x.interaction).at(-1).interaction.approvalInteraction.confirm, true);
  } finally { await c.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Hub ACP submits structured question answers with actual option IDs, multi-select, skip and cancellation', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-acp-questions-'));
  copyFileSync(join(ROOT, 'test/fixtures/hub-server.mjs'), join(dir, 'fake-hub')); chmodSync(join(dir, 'fake-hub'), 0o700);
  writeFileSync(join(dir, 'rpc.jsonl'), '');
  const c = client(dir);
  const interactions = () => readFileSync(join(dir, 'rpc.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x => x.method === 'HandleCascadeUserInteraction');
  const select = (request, optionId) => c.send({ id: request.id, result: { outcome: { outcome: 'selected', optionId } } });
  const start = async text => {
    const { sessionId } = await c.request('session/new', { cwd: dir, mcpServers: [] });
    return { sessionId, running: c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }) };
  };
  try {
    for (const name of ['question', 'question-native']) {
      const { sessionId, running } = await start(name);
      const request = await c.permission();
      assert.equal(request.params.toolCall.title, 'Your input is needed');
      assert.equal(typeof request.params.toolCall.rawInput, 'string');
      assert.doesNotMatch(request.params.toolCall.rawInput, /toolSummary|is_multi_select|toolAction/);
      assert.deepEqual(request.params.options.map(o => o.name), ['Choose 1', 'Choose 2', 'Choose 3', 'Skip this question', 'Cancel answering']);
      assert.match(request.params.toolCall.content[0].content.text, /2\. 同时更新用户管理/);
      const snapshot = c.notifications.filter(n => n.sessionId === sessionId && n.update.toolCallId === request.params.toolCall.toolCallId).at(-1).update;
      assert.deepEqual(snapshot.content, request.params.toolCall.content);
      assert.equal(snapshot.rawInput, request.params.toolCall.rawInput);
      select(request, 'answer:1');
      assert.deepEqual(await running, { stopReason: 'end_turn' });
      const sent = interactions().filter(x => x.body.cascadeId === sessionId);
      assert.equal(sent.length, 1, 'duplicate waiting snapshots must not ask twice');
      assert.equal(sent[0].body.interaction.trajectoryId, sessionId);
      assert.equal(sent[0].body.interaction.stepIndex, 7);
      assert.deepEqual(sent[0].body.interaction.askQuestion, { responses: [{ question: '请选择前端改动范围', options: [{ id: 'scope-agent', text: '仅更新充值代理管理' }, { id: 'scope-both', text: '同时更新用户管理' }, { id: 'scope-user', text: '仅更新用户管理' }], isMultiSelect: false, selectedOptionIds: ['scope-both'], writeInResponse: '', skipped: false }], cancelled: false });
    }
    const multiple = await start('question-multiple');
    select(await c.permission(), 'answer:2');
    let request = await c.permission();
    assert.match(request.params.toolCall.title, /2\/3/);
    assert.ok(!request.params.options.some(o => o.optionId === 'submit'));
    select(request, 'answer:0');
    request = await c.permission();
    assert.equal(request.params.options[0].name, '☑ 1');
    select(request, 'answer:1');
    select(await c.permission(), 'answer:0'); // Toggle the first choice off.
    request = await c.permission();
    assert.equal(request.params.options[0].name, '☐ 1');
    assert.equal(request.params.options[1].name, '☑ 2');
    assert.equal(interactions().filter(x => x.body.cascadeId === multiple.sessionId).length, 0);
    select(request, 'submit');
    request = await c.permission();
    assert.match(request.params.toolCall.title, /3\/3/);
    select(request, 'skip');
    await multiple.running;
    const answers = interactions().at(-1).body.interaction.askQuestion;
    assert.equal(answers.cancelled, false);
    assert.deepEqual(answers.responses.map(r => r.selectedOptionIds), [['scope-user'], ['filter'], []]);
    assert.deepEqual(answers.responses.map(r => r.skipped), [false, false, true]);

    for (const outcome of [{ outcome: 'selected', optionId: 'cancel' }, { outcome: 'selected', optionId: 'allow_once' }, { outcome: 'cancelled' }]) {
      const { running } = await start('question-multiple');
      select(await c.permission(), 'answer:0');
      const request = await c.permission();
      c.send({ id: request.id, result: { outcome } });
      await running;
      assert.deepEqual(interactions().at(-1).body.interaction.askQuestion, { responses: [], cancelled: true });
    }
    const cancelled = await start('question');
    await c.permission();
    c.send({ method: 'session/cancel', params: { sessionId: cancelled.sessionId } });
    assert.deepEqual(await cancelled.running, { stopReason: 'cancelled' });
    assert.equal(interactions().filter(x => x.body.cascadeId === cancelled.sessionId).length, 0);
  } finally { await c.close(); rmSync(dir, { recursive: true, force: true }); }
});
