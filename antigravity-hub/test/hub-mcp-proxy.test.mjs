import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMcpProxy } from '../src/hub/mcp-proxy.mjs';

// Mirrors @modelcontextprotocol/sdk 1.x: a known version header is required to match,
// a missing one falls back to the negotiated version, and replies stream as SSE.
async function upstream() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const version = req.headers['mcp-protocol-version'];
      seen.push({ method: req.method, url: req.url, version, auth: req.headers.authorization, body });
      if (version && version !== '2025-11-25') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: `Bad Request: Unsupported protocol version: ${version} (supported versions: 2025-11-25)` }, id: null }));
        return;
      }
      if (req.headers.authorization !== 'Bearer secret') { res.writeHead(401).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'abc' });
      res.write('event: message\n');
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { tools: [{ name: 'list_agents' }] } })}\n\n`);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/mcp/agents?callerAgentId=a1`, seen, close: () => new Promise(r => server.close(r)) };
}

const post = (url, version) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer secret', ...(version ? { 'mcp-protocol-version': version } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
});

test('MCP proxy retries without a protocol version header the upstream does not support', async () => {
  const up = await upstream(), proxy = createMcpProxy();
  try {
    const local = await proxy.route(up.url);
    assert.match(local, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]{36}$/);
    const res = await post(local, '2026-07-28');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('mcp-session-id'), 'abc');
    assert.match(await res.text(), /"list_agents"/);
    assert.deepEqual(up.seen.map(r => [r.url, r.version, r.auth]), [
      ['/mcp/agents?callerAgentId=a1', '2026-07-28', 'Bearer secret'],
      ['/mcp/agents?callerAgentId=a1', undefined, 'Bearer secret'],
    ]);
    assert.equal(up.seen[1].body, up.seen[0].body);
  } finally { await proxy.close(); await up.close(); }
});

test('MCP proxy forwards supported versions once and passes other errors through', async () => {
  const up = await upstream(), proxy = createMcpProxy();
  try {
    const local = await proxy.route(up.url);
    assert.equal((await post(local, '2025-11-25')).status, 200);
    assert.equal(up.seen.length, 1);
    const denied = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
    assert.equal(up.seen.length, 2);
    assert.equal((await fetch(local.replace(/[0-9a-f-]{36}$/, '00000000-0000-0000-0000-000000000000'))).status, 404);
    assert.equal(await proxy.route(up.url), local, 'same upstream reuses its route');
  } finally { await proxy.close(); await up.close(); }
});

test('MCP proxy reports when a tools/list exchange through a route finishes', async () => {
  const up = await upstream(), proxy = createMcpProxy();
  try {
    const local = await proxy.route(up.url);
    let listed = false;
    const waiting = proxy.toolsListed(up.url).then(() => { listed = true; });
    await fetch(local, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer secret' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }).then(r => r.text());
    await new Promise(r => setTimeout(r, 50));
    assert.equal(listed, false, 'initialize does not count');
    await (await post(local, '2026-07-28')).text();
    await waiting;
    assert.equal(listed, true);
    await assert.rejects(proxy.toolsListed('http://127.0.0.1:1/unrouted'), /Unknown MCP route/);
  } finally { await proxy.close(); await up.close(); }
});
