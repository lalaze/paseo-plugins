import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const scripts = pathToFileURL(join(import.meta.dirname, '../scripts/')).href;
const { shouldMuteDirectorFinish: mute } = await import(scripts + 'notification-policy.mjs');
const { transform, locate } = await import(scripts + 'notification-patch.mjs');
const main = { labels: { 'director-conversation': 'chat', 'director-role': 'chat' } };
const notice = (state: unknown) => [{ type: 'user_message', clientMessageId: 'chat-notice:one', text: '[paseo-director-chat:chat-notice:one]\n后台状态通知\n' + JSON.stringify(state) }];

test('worker and reviewer completion is quiet; permissions and errors still notify', () => {
  for (const role of ['worker', 'reviewer', 'director']) {
    const agent = { labels: { 'director-run': 'run', 'director-role': role } };
    assert.equal(mute(agent, 'finished', []), true);
    for (const reason of ['permission', 'error']) assert.equal(mute(agent, reason, []), false);
  }
  assert.equal(mute({ labels: {} }, 'finished', []), false);
});

test('main intermediate reports are quiet, while approval and final outcomes notify', () => {
  for (const phase of ['planning', 'executing', 'reviewing', 'final_review']) assert.equal(mute(main, 'finished', notice({ phase, control: 'running' })), true);
  for (const state of [
    { phase: 'executing', control: 'paused', confirmation: { kind: 'plan' } },
    { phase: 'awaiting_acceptance', control: 'paused' }, { phase: 'completed', control: 'running' },
    { phase: 'executing', control: 'needs_attention' }, { phase: 'executing', control: 'waiting_permission' },
  ]) assert.equal(mute(main, 'finished', notice(state)), false);
  assert.equal(mute(main, 'finished', [...notice({ phase: 'executing', control: 'running' }), { type: 'user_message', messageId: 'user', text: '进度如何？' }]), false);
  assert.equal(mute(main, 'finished', [{ type: 'user_message', messageId: 'user', text: '第三项完成' }]), false);
  assert.equal(mute(main, 'finished', notice(null)), false);
});

test('automatic operation/bootstrap turns are quiet, genuine director commands retain notifications', () => {
  assert.equal(mute(main, 'finished', [{ type: 'user_message', messageId: 'op', text: '[paseo-director:op]\n执行交接' }]), true);
  assert.equal(mute(main, 'finished', [{ type: 'user_message', messageId: 'chat-command:1', text: '用户已在当前对话启用协作。\n\n[paseo-director-takeover]\n配置' }]), true);
  assert.equal(mute(main, 'finished', [{ type: 'user_message', messageId: 'chat-command:2', text: '实现功能\n\n[paseo-director-takeover]\n配置' }]), false);
});

test('host patch is reversible and suppresses both push and in-app delivery while preserving attention events', () => {
  const source = `class Server {\n    async broadcastAgentAttention(params) {\n        const agent = this.agentManager.getAgent(params.agentId);\n        const clientEntries = [];\n        const plan = { shouldPush: true, inAppRecipientIndex: 0 };\n        if (plan.shouldPush) { this.pushes++; }\n        for (const clientIndex of [0]) {\n            const shouldNotify = clientIndex === plan.inAppRecipientIndex;\n            this.events.push({ shouldNotify, reason: params.reason });\n        }\n    }\n    async broadcastTerminalAttention(params) {}\n}`;
  const patched = transform(source);
  assert.equal(transform(patched), patched); assert.equal(transform(patched, true), source);
  assert.throws(() => transform(source.replace('plan.shouldPush', 'plan.sendPush')), /anchor changed/);
  const Server = new Function(patched + '; return Server;')();
  return (async () => {
    for (const [agent, reason, timeline, expected] of [
      [main, 'finished', notice({ phase: 'executing', control: 'running' }), false],
      [main, 'finished', notice({ phase: 'awaiting_acceptance', control: 'paused' }), true],
      [{ labels: { 'director-run': 'r', 'director-role': 'worker' } }, 'permission', [], true],
      [{ labels: {} }, 'finished', [], true],
    ] as const) {
      const host = new Server(); host.pushes = 0; host.events = []; host.agentManager = { getAgent: () => agent, getTimeline: () => timeline };
      await host.broadcastAgentAttention({ agentId: 'a', reason });
      assert.equal(host.pushes, expected ? 1 : 0); assert.deepEqual(host.events, [{ shouldNotify: expected, reason }]);
    }
  })();
});

test('installed Paseo dispatcher matches the guarded patch and rolls back byte-for-byte', t => {
  let target;
  try { target = locate(process.env.PASEO_PATCH_TEST_CLI); } catch (error) { if (error instanceof Error && error.message.startsWith('Paseo CLI not found')) { t.skip('Paseo CLI is not installed'); return; } throw error; }
  const source = readFileSync(target.path, 'utf8');
  const original = transform(source, true), patched = transform(original);
  assert.equal(transform(patched, true), original);
});

test('0.9 filtered notification recipients retain selection and event delivery', async () => {
  const source = `class Server {
    async broadcastAgentAttention(params) {
        const agent = this.agentManager.getAgent(params.agentId);
        const clientEntries = [];
        clientEntries.push({ ws: 'events-only' }, { ws: 'notifications' });
        const notificationEntries = clientEntries.slice(1);
        const plan = { shouldPush: true, inAppRecipientIndex: params.recipient };
        if (plan.shouldPush) { this.pushes++; }
        for (const { ws } of clientEntries) {
            const shouldNotify = plan.inAppRecipientIndex !== null &&
                notificationEntries[plan.inAppRecipientIndex]?.ws === ws;
            this.events.push({ ws, shouldNotify });
        }
    }
    async broadcastTerminalAttention(params) {}
}`;
  const patched = transform(source);
  assert.equal(transform(patched), patched);
  assert.equal(transform(patched, true), source);
  assert.throws(() => transform(source.replace('notificationEntries[plan.inAppRecipientIndex]?.ws', 'clientEntries[plan.inAppRecipientIndex]?.ws')), /anchor changed/);
  const Server = new Function(patched + '; return Server;')();
  const worker = { labels: { 'director-run': 'run', 'director-role': 'worker' } };
  for (const [agent, reason, muted] of [[worker, 'finished', true], [worker, 'permission', false], [worker, 'error', false], [{ labels: {} }, 'finished', false]] as const) {
    for (const recipient of [null, 0, 1]) {
      const host = new Server();
      host.pushes = 0; host.events = [];
      host.agentManager = { getAgent: () => agent, getTimeline: () => [] };
      await host.broadcastAgentAttention({ agentId: 'a', reason, recipient });
      assert.equal(host.pushes, muted ? 0 : 1);
      assert.deepEqual(host.events, [{ ws: 'events-only', shouldNotify: false }, { ws: 'notifications', shouldNotify: !muted && recipient === 0 }]);
    }
  }
});
