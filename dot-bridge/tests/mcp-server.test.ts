import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BridgeEngine } from '../server/engine';
import type { FetchLike } from '../server/http';
import { createMcpServer, type McpServerHandle } from '../server/mcp-server';
import { generateSecret } from '../server/signing';
import { BridgeStore } from '../server/store';
import { eventEnvelopeSchema, taskChangedDataSchema, type EventEnvelope } from '../shared/mcp';

const scratch: string[] = [];
after(() => Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true }))));

const BASE = '1'.repeat(40);

function echoFetch(): FetchLike {
  return async (_url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    try {
      const parsed = JSON.parse(body) as { type?: string; challenge?: string };
      if (parsed.type === 'verification' && typeof parsed.challenge === 'string') {
        return new Response(JSON.stringify({ challenge: parsed.challenge }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    } catch {
      /* ignore */
    }
    return new Response('', { status: 200 });
  };
}

async function setup(fetchImpl: FetchLike = echoFetch()): Promise<{ engine: BridgeEngine; server: McpServerHandle; endpoint: string; token: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dot-bridge-mcp-'));
  scratch.push(dir);
  const store = await BridgeStore.open(dir);
  const engine = new BridgeEngine({
    store,
    git: {
      inspectRepository: async () => ({ directory: null, remotes: [], branch: null, head: null, dirty: false, unpushed: false }),
      resolveRepository: async d => d,
      verifyResult: async () => ({ ok: false, code: 'git-failed', detail: 'not used' }),
      baseReachable: async () => true,
      prMatches: async () => true,
    },
    getMaxInFlight: () => 2,
    allowPrivateCallback: true,
    fetchImpl,
    randomId: () => randomUUID(),
  });
  await engine.init();
  engine.setBridgeListening(true);
  const server = createMcpServer({ engine, host: '127.0.0.1', port: 0, getToken: () => engine.mcpToken() });
  const bound = await server.start();
  return { engine, server, endpoint: bound.endpoint, token: engine.mcpToken() };
}

async function rpc(endpoint: string, token: string | null, method: string, params: unknown = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('MCP HTTP server', () => {
  it('rejects an unauthenticated request', async () => {
    const { server, endpoint } = await setup();
    try {
      const result = await rpc(endpoint, null, 'initialize');
      assert.equal(result.status, 401);
    } finally {
      await server.stop();
    }
  });

  it('answers initialize and server/discover with the events protocol version', async () => {
    const { server, endpoint, token } = await setup();
    try {
      const init = await rpc(endpoint, token, 'initialize');
      assert.equal((init.body.result as { protocolVersion: string }).protocolVersion, '2026-07-28');
      const discover = await rpc(endpoint, token, 'server/discover');
      const result = discover.body.result as { resultType: string; supportedVersions: string[]; capabilities: { events: { delivery: string[] } } };
      assert.equal(result.resultType, 'complete');
      assert.deepEqual(result.supportedVersions, ['2026-07-28']);
      assert.deepEqual(result.capabilities.events.delivery, ['webhook']);
    } finally {
      await server.stop();
    }
  });

  it('lists events with the official definition fields', async () => {
    const { server, endpoint, token } = await setup();
    try {
      const result = await rpc(endpoint, token, 'events/list');
      const events = (result.body.result as { events: Array<{ name: string; delivery: string[]; inputSchema: unknown; payloadSchema: unknown }> }).events;
      assert.deepEqual(events.map(event => event.name), ['paseo.dot.task_changed', 'paseo.dot.connection_test']);
      assert.deepEqual(events[0].delivery, ['webhook']);
      assert.ok(events[0].inputSchema);
      assert.ok(events[0].payloadSchema);
    } finally {
      await server.stop();
    }
  });

  it('marks read-only tools correctly and write tools not read-only', async () => {
    const { server, endpoint, token } = await setup();
    try {
      const result = await rpc(endpoint, token, 'tools/list');
      const tools = (result.body.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }).tools;
      const byName = new Map(tools.map(tool => [tool.name, tool.annotations.readOnlyHint]));
      assert.equal(byName.get('list_dot_tasks'), true);
      assert.equal(byName.get('get_dot_task'), true);
      assert.equal(byName.get('get_dot_task_status'), true);
      assert.equal(byName.get('get_dot_task_history'), true);
      assert.equal(byName.get('claim_dot_task'), false);
      assert.equal(byName.has('submit_dot_result'), false);
      assert.equal(byName.get('read_dot_file'), true);
      assert.equal(byName.get('list_dot_files'), true);
      assert.equal(byName.get('apply_dot_changes'), false);
      assert.equal(byName.get('submit_dot_text_result'), false);
      assert.equal(byName.get('confirm_dot_connection'), false);
    } finally {
      await server.stop();
    }
  });

  it('runs list_dot_tasks through tools/call', async () => {
    const { engine, server, endpoint, token } = await setup();
    try {
      const task = await engine.createTask({
        operationId: randomUUID(),
        workspaceId: 'ws-1',
        title: 'T',
        requirement: 'R',
        acceptance: '',
        repository: 'https://github.com/acme/repo.git',
        remoteName: 'origin',
        baseSha: BASE,
        targetBranch: 'main',
        environmentHint: '',
      });
      const result = await rpc(endpoint, token, 'tools/call', { name: 'list_dot_tasks', arguments: { connectionId: engine.connection().id } });
      const content = (result.body.result as { content: Array<{ text: string }> }).content;
      const parsed = JSON.parse(content[0].text) as { tasks: Array<{ taskId: string }> };
      assert.equal(parsed.tasks[0].taskId, task.id);
    } finally {
      await server.stop();
    }
  });

  it('accepts MCP request metadata outside tool arguments', async () => {
    const { engine, server, endpoint, token } = await setup();
    try {
      const result = await rpc(endpoint, token, 'tools/call', {
        name: 'list_dot_tasks',
        arguments: { connectionId: engine.connection().id },
        _meta: { progressToken: 'chatgpt-request', 'openai/locale': 'zh-CN', 'example/context': { source: 'dot' } },
      });
      assert.equal(result.body.error, undefined);
      const content = (result.body.result as { content: Array<{ text: string }> }).content;
      assert.deepEqual(JSON.parse(content[0].text).tasks, []);
    } finally {
      await server.stop();
    }
  });

  it('keeps tool inputs strict and rejects malformed request metadata', async () => {
    const { engine, server, endpoint, token } = await setup();
    try {
      const call = { name: 'list_dot_tasks', arguments: { connectionId: engine.connection().id } };
      for (const params of [
        { ...call, _meta: 'invalid' },
        { ...call, _meta: [] },
        { ...call, unexpected: true },
        { ...call, arguments: { ...call.arguments, _meta: { progressToken: 'misplaced' } } },
        { ...call, arguments: { ...call.arguments, unexpected: true }, _meta: {} },
      ]) {
        const result = await rpc(endpoint, token, 'tools/call', params);
        assert.ok(result.body.error, JSON.stringify(params));
        assert.equal(result.body.result, undefined);
      }
    } finally {
      await server.stop();
    }
  });

  it('accepts MCP request metadata on event subscribe and unsubscribe', async () => {
    const { engine, server, endpoint, token } = await setup();
    try {
      const identity = {
        name: 'paseo.dot.task_changed',
        arguments: { connectionId: engine.connection().id },
        delivery: { mode: 'webhook', url: 'https://example.com/hook' },
      };
      const subscribed = await rpc(endpoint, token, 'events/subscribe', {
        ...identity,
        delivery: { ...identity.delivery, secret: generateSecret() },
        _meta: { 'openai/locale': 'zh-CN' },
      });
      assert.equal(subscribed.body.error, undefined);
      assert.equal(engine.connection().subscriptions.length, 1);
      const unsubscribed = await rpc(endpoint, token, 'events/unsubscribe', { ...identity, _meta: {} });
      assert.equal(unsubscribed.body.error, undefined);
      assert.equal(engine.connection().subscriptions.length, 0);
    } finally {
      await server.stop();
    }
  });

  it('subscribes with the official response shape and unsubscribes by identity', async () => {
    const { engine, server, endpoint, token } = await setup();
    try {
      const connectionId = engine.connection().id;
      const params = {
        name: 'paseo.dot.task_changed',
        arguments: { connectionId },
        delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret() },
        cursor: null,
      };
      const subscribed = await rpc(endpoint, token, 'events/subscribe', params);
      const result = subscribed.body.result as { id: string; refreshBefore: string; cursor: null; truncated: boolean };
      assert.equal(typeof result.id, 'string');
      assert.equal(result.truncated, false);
      // refreshBefore is an ISO instant strictly in the future, and cursor is null (no replay).
      assert.ok(Number.isFinite(Date.parse(result.refreshBefore)));
      assert.ok(Date.parse(result.refreshBefore) > Date.now());
      assert.equal(result.cursor, null);
      const unsubscribed = await rpc(endpoint, token, 'events/unsubscribe', {
        name: 'paseo.dot.task_changed',
        arguments: { connectionId },
        delivery: { mode: 'webhook', url: 'https://example.com/hook' },
      });
      assert.ok(unsubscribed.body.result !== undefined);
      assert.equal(engine.connection().subscriptions.length, 0);
    } finally {
      await server.stop();
    }
  });

  it('stops accepting requests after stop, releasing held connections', async () => {
    const { server, endpoint, token } = await setup();
    await server.stop();
    assert.equal(server.address().listening, false);
    await assert.rejects(() => rpc(endpoint, token, 'initialize'));
  });

  it('returns the official CallbackEndpointError when verification fails', async () => {
    const { engine, server, endpoint, token } = await setup(async () => new Response('', { status: 200 }));
    try {
      const result = await rpc(endpoint, token, 'events/subscribe', {
        name: 'paseo.dot.task_changed',
        arguments: { connectionId: engine.connection().id },
        delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret() },
        cursor: null,
      });
      const error = (result.body as { error: { code: number; data?: { reason?: string } } }).error;
      assert.equal(error.code, -32015);
      assert.equal(error.data?.reason, 'challenge_failed');
    } finally {
      await server.stop();
    }
  });
});


it('completes a repository-free task through the authenticated MCP text tool', async () => {
  const { engine, server, endpoint, token } = await setup();
  try {
    const task = await engine.createTask({
      operationId: randomUUID(), workspaceId: 'ws-text', mode: 'text', title: 'Analysis',
      requirement: 'Explain the plan', acceptance: '', repository: null, remoteName: null,
      baseSha: null, targetBranch: null, environmentHint: '',
    });
    const ordinaryRead = await rpc(endpoint, token, 'tools/call', { name: 'get_dot_task', arguments: { connectionId: task.connectionId, taskId: task.id } });
    assert.equal(JSON.parse((ordinaryRead.body.result as { content: Array<{ text: string }> }).content[0].text).conversationInstructions, undefined);
    await engine.setSubscription({ name: 'paseo.dot.task_changed', arguments: { connectionId: task.connectionId }, delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret() }, cursor: null });
    const challenge = await engine.startConnectionTest(randomUUID());
    await engine.confirmConnection(task.connectionId, challenge.challenge);
    await engine.dispatchTick();
    await rpc(endpoint, token, 'tools/call', { name: 'claim_dot_task', arguments: { connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId } });
    const fileArgs = { connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId, operationId: randomUUID(), name: 'sample.bin', mediaType: 'application/octet-stream', encoding: 'base64', content: Buffer.alloc(1024 * 1024, 0xa5).toString('base64') };
    const uploaded = await rpc(endpoint, token, 'tools/call', { name: 'upload_dot_attachment', arguments: fileArgs });
    assert.equal(uploaded.body.error, undefined);
    assert.equal(engine.task(task.id).attachments.length, 1);
    const read = await rpc(endpoint, token, 'tools/call', { name: 'read_dot_attachment', arguments: { connectionId: task.connectionId, taskId: task.id, attachmentId: fileArgs.operationId } });
    assert.equal(read.body.error, undefined);
    const readPayload = JSON.parse((read.body.result as { content: Array<{ text: string }> }).content[0].text);
    assert.equal(readPayload.content, fileArgs.content);
    await rpc(endpoint, token, 'tools/call', { name: 'upload_dot_attachment', arguments: fileArgs });
    assert.equal(engine.task(task.id).attachments.length, 1);
    const args = { connectionId: task.connectionId, taskId: task.id, roundId: task.currentRoundId, updateId: randomUUID(), text: '先验证文字交流，再增加附件。', processedThroughSeq: 1 };
    assert.equal((await rpc(endpoint, null, 'tools/call', { name: 'submit_dot_text_result', arguments: args })).status, 401);
    const response = await rpc(endpoint, token, 'tools/call', { name: 'submit_dot_text_result', arguments: args });
    assert.equal(response.body.error, undefined);
    assert.equal(engine.task(task.id).status, 'completed');
    assert.equal(engine.task(task.id).rounds[0].result?.summary, args.text);
    assert.equal(engine.task(task.id).rounds[0].verification.status, 'none');
    const invalid = await rpc(endpoint, token, 'tools/call', { name: 'submit_dot_text_result', arguments: { ...args, updateId: randomUUID(), text: ' ' } });
    assert.ok(invalid.body.error);
    await rpc(endpoint, token, 'tools/call', { name: 'submit_dot_text_result', arguments: args });
    assert.equal(engine.task(task.id).rounds[0].resultHistory.length, 0);
  } finally {
    await server.stop();
  }
});

it('provides current chat progress instructions when reading an existing native provider task', async () => {
  const { engine, server, endpoint, token } = await setup();
  try {
    const { task } = await engine.providerPrompt({ id: randomUUID(), operationId: randomUUID(), clientMessageId: randomUUID(), cwd: '/repo', workspaceId: 'ws-chat', body: 'Compare two options', systemPrompt: '', attachments: [] });
    const response = await rpc(endpoint, token, 'tools/call', { name: 'get_dot_task', arguments: { connectionId: task.connectionId, taskId: task.id } });
    assert.equal(response.body.error, undefined);
    const payload = JSON.parse((response.body.result as { content: Array<{ text: string }> }).content[0].text);
    assert.equal(payload.task.id, task.id);
    assert.match(payload.conversationInstructions, /report_dot_progress/);
    assert.match(payload.conversationInstructions, /private reasoning/);
    assert.match(payload.conversationInstructions, /complete final answer/);
  } finally { await server.stop(); }
});

it('a new task webhook identifies the exact task to read and claim after an earlier task completes', async () => {
  const delivered: EventEnvelope[] = [];
  const echo = echoFetch();
  const { engine, server, endpoint, token } = await setup(async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.name === 'paseo.dot.task_changed') delivered.push(eventEnvelopeSchema.parse(body));
    return echo(url, init);
  });
  try {
    const connectionId = engine.connection().id;
    await engine.setSubscription({ name: 'paseo.dot.task_changed', arguments: { connectionId }, delivery: {
      mode: 'webhook', url: 'https://example.com/hook', secret: generateSecret(),
    }, cursor: null });
    const challenge = await engine.startConnectionTest(randomUUID());
    await engine.confirmConnection(connectionId, challenge.challenge);
    const create = async (body: string) => (await engine.providerPrompt({ id: randomUUID(), operationId: randomUUID(),
      clientMessageId: randomUUID(), cwd: '/repo', workspaceId: 'ws-chat', body, systemPrompt: '', attachments: [] })).task;
    const first = await create('First task');
    await engine.dispatchTick(); await engine.deliverTick();
    await engine.claimTask({ connectionId, taskId: first.id, roundId: first.currentRoundId });
    const completed = await rpc(endpoint, token, 'tools/call', { name: 'submit_dot_text_result', arguments: {
      connectionId, taskId: first.id, roundId: first.currentRoundId, updateId: randomUUID(), text: 'Done', processedThroughSeq: first.userMessageSeq,
    } });
    assert.equal(completed.body.error, undefined);
    assert.equal(engine.task(first.id).status, 'completed');
    const second = await create('Verify the new game session');
    await engine.dispatchTick(); await engine.deliverTick();
    const notification = delivered.at(-1); assert.ok(notification);
    const data = taskChangedDataSchema.parse(notification.data);
    assert.equal(data.taskId, second.id); assert.equal(data.roundId, second.currentRoundId);
    assert.notEqual(data.taskId, first.id); assert.notEqual(data.taskId, notification.eventId);
    // Use only the delivered identity, without a queue listing or the previous task ID.
    const read = await rpc(endpoint, token, 'tools/call', { name: 'get_dot_task', arguments: { connectionId, taskId: data.taskId } });
    assert.equal(read.body.error, undefined);
    const context = JSON.parse((read.body.result as { content: Array<{ text: string }> }).content[0].text);
    assert.equal(context.task.id, second.id);
    const claimed = await rpc(endpoint, token, 'tools/call', { name: 'claim_dot_task', arguments: {
      connectionId, taskId: data.taskId, roundId: context.task.currentRoundId,
    } });
    assert.equal(claimed.body.error, undefined);
    assert.equal(engine.task(second.id).status, 'claimed');
    assert.equal(engine.task(first.id).status, 'completed');
  } finally { await server.stop(); await engine.dispose(); }
});
