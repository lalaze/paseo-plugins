import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { BridgeListener } from '../server/listener';
import { createMcpServer } from '../server/mcp-server';
import type { BridgeEngine } from '../server/engine';

test('listener retries unchanged failed settings with backoff, clears errors and rebinds changed settings', async t => {
  let now = 0, attempts = 0, stops = 0;
  const states: boolean[] = [];
  const listener = new BridgeListener({
    now: () => now, report: () => {}, listening: value => states.push(value),
    create: (host, port) => {
      let listening = false;
      return {
        async start() { attempts++; if (attempts < 3) throw new Error('port busy'); listening = true; return { host, port, endpoint: host }; },
        async stop() { stops++; listening = false; },
        address: () => ({ host, port, endpoint: host, listening, error: null }),
      };
    },
  });
  t.after(() => listener.stop());
  await listener.ensure('127.0.0.1', 1234);
  assert.equal(listener.address().error, 'port busy');
  await listener.ensure('127.0.0.1', 1234); assert.equal(attempts, 1);
  now = 2500; await listener.ensure('127.0.0.1', 1234); assert.equal(attempts, 2);
  now = 7499; await listener.ensure('127.0.0.1', 1234); assert.equal(attempts, 2);
  now = 7500; await listener.ensure('127.0.0.1', 1234);
  assert.equal(listener.address().listening, true); assert.equal(listener.address().error, null);
  await listener.ensure('127.0.0.1', 1234); assert.equal(attempts, 3);
  await listener.ensure('127.0.0.1', 2345); assert.equal(attempts, 4);
  assert.equal(listener.address().port, 2345); assert.ok(stops >= 3);
  await listener.stop(); await listener.ensure('127.0.0.1', 2345);
  assert.equal(attempts, 4); assert.equal(states.at(-1), false);
});

test('concurrent polls share one bind and shutdown during startup cannot leave a live listener', async () => {
  let release!: () => void, starts = 0, stopped = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const listener = new BridgeListener({
    report: () => {}, listening: () => {},
    create: () => ({
      async start() { starts++; await gate; return { host: 'local', port: 1, endpoint: 'local' }; },
      async stop() { stopped = true; },
      address: () => ({ host: 'local', port: 1, endpoint: 'local', listening: !stopped, error: null }),
    }),
  });
  const first = listener.ensure('local', 1), second = listener.ensure('local', 1);
  assert.equal(first, second);
  await Promise.resolve();
  const stopping = listener.stop(); release();
  await Promise.all([first, second, stopping]);
  assert.equal(starts, 1); assert.equal(stopped, true); assert.equal(listener.address().listening, false);
});

test('MCP listener reports EADDRINUSE and can start again once the real port is released', async t => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, '127.0.0.1', resolve); });
  t.after(() => { blocker.close(); });
  const address = blocker.address(); assert.ok(address && typeof address === 'object');
  const server = createMcpServer({ engine: {} as BridgeEngine, host: '127.0.0.1', port: address.port, getToken: () => 'test' });
  t.after(() => server.stop());
  await assert.rejects(server.start(), /EADDRINUSE/);
  assert.equal(server.address().listening, false); assert.match(server.address().error!, /EADDRINUSE/);
  await new Promise<void>(resolve => blocker.close(() => resolve()));
  await server.start();
  assert.equal(server.address().listening, true); assert.equal(server.address().error, null);
});
