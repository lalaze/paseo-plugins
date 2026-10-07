import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeServer, parseServerJson, parseServerList, serversFor } from '../server/mcp';

test('reads Claude-style entries, with and without a type', () => {
  assert.deepEqual(normalizeServer({ command: 'npx', args: ['-y', 'pkg'], env: { A: '1', B: 2 } }), { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } });
  assert.deepEqual(normalizeServer({ type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } }), { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } });
  assert.deepEqual(normalizeServer({ type: 'sse', url: 'https://x/sse' }), { type: 'sse', url: 'https://x/sse' });
  assert.deepEqual(normalizeServer({ url: 'https://x/mcp' }), { type: 'http', url: 'https://x/mcp' });
});

test('reads Gemini httpUrl and Codex transports', () => {
  assert.deepEqual(normalizeServer({ httpUrl: 'https://g/mcp' }), { type: 'http', url: 'https://g/mcp' });
  assert.deepEqual(
    normalizeServer({ name: 'fs', transport: { type: 'stdio', command: 'fs-mcp', args: [], env: null, cwd: '.' } }),
    { type: 'stdio', command: 'fs-mcp' },
  );
  assert.deepEqual(
    normalizeServer({ name: 'docs', transport: { type: 'streamable_http', url: 'https://d/mcp', http_headers: { X: 'y' }, bearer_token: 'tok' } }),
    { type: 'http', url: 'https://d/mcp', headers: { X: 'y', Authorization: 'Bearer tok' } },
  );
});

test('refuses what Paseo cannot pass on', () => {
  assert.throws(() => normalizeServer({ type: 'ws', url: 'ws://x' }), /not supported/);
  assert.throws(() => normalizeServer({ args: ['x'] }), /command.*url/);
  assert.throws(() => normalizeServer({ type: 'stdio', url: 'https://x' }), /Needs a "command"/);
  assert.throws(() => normalizeServer({ transport: { type: 'streamable_http', url: 'https://d', bearer_token_env_var: 'TOKEN' } }), /\$TOKEN/);
});

test('parses pasted lists and reports what it skipped', () => {
  const parsed = parseServerJson(JSON.stringify({ mcpServers: { good: { command: 'a' }, paseo: { command: 'b' }, 'bad name': { command: 'c' }, broken: {} } }));
  assert.deepEqual(Object.keys(parsed.servers), ['good']);
  assert.equal(parsed.skipped.length, 3);
  assert.deepEqual(Object.keys(parseServerJson('{"x":{"command":"a"}}').servers), ['x']);
  assert.deepEqual(Object.keys(parseServerList([{ name: 'c', transport: { type: 'stdio', command: 'c' } }]).servers), ['c']);
  assert.throws(() => parseServerJson('{'), /valid JSON/);
});

test('adds enabled servers for the provider without replacing the request\'s own', () => {
  const shared = {
    all: { type: 'stdio' as const, command: 'all' },
    off: { type: 'stdio' as const, command: 'off', enabled: false },
    onlyCodex: { type: 'http' as const, url: 'https://c', providers: ['codex'] },
    mine: { type: 'stdio' as const, command: 'shared' },
    director: { type: 'stdio' as const, command: 'nope' },
  };
  assert.deepEqual(serversFor('claude', shared, { mine: { type: 'stdio', command: 'request' } }), { all: { type: 'stdio', command: 'all' } });
  assert.deepEqual(Object.keys(serversFor('codex', shared, undefined)).sort(), ['all', 'mine', 'onlyCodex']);
  assert.deepEqual(serversFor('codex', shared, undefined).onlyCodex, { type: 'http', url: 'https://c' });
});
