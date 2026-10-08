import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { sameResource, savedCredentials } from '../server/credentials';

const MCP = 'https://mcp.example.com/v1/mcp';
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'shared-credentials-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
async function save(path: string, data: unknown) {
  const target = join(home, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, JSON.stringify(data));
}

test('matches the full MCP resource, not the display name or the host alone', () => {
  assert.equal(sameResource('https://MCP.EXAMPLE.com:443/v1/mcp', MCP), true);
  for (const url of ['https://mcp.example.com/other', `${MCP}?tenant=other`, `${MCP}#x`, 'http://mcp.example.com/v1/mcp', 'https://user@mcp.example.com/v1/mcp', 'invalid']) {
    assert.equal(sameResource(url, MCP), false, url);
  }
});

test('reads Codex and Claude access tokens by URL regardless of server name, without refresh credentials', async () => {
  const expires = Date.now() + 60_000;
  await save('.codex/.credentials.json', {
    'renamed|hash': { server_url: MCP, access_token: 'codex-access', refresh_token: 'never-copy', client_id: 'secret-client', expires_at: expires, scopes: ['files:read'] },
    'files|other': { server_url: 'https://other.example.com/mcp', access_token: 'wrong-resource' },
  });
  await save('.claude/.credentials.json', { mcpOAuth: { anything: { serverUrl: MCP, accessToken: 'claude-access', expiresAt: expires + 60_000 } } });
  const found = await savedCredentials(home, MCP);
  assert.deepEqual(found.map(item => item.provider), ['claude', 'codex']);
  assert.deepEqual(found[1]?.tokens, { access_token: 'codex-access', expires_at: expires, scope: 'files:read' });
  assert.equal(JSON.stringify(found).includes('never-copy'), false);
  assert.deepEqual((await savedCredentials(home, MCP, 'codex')).map(item => item.provider), ['codex']);
});

test('malformed caches and invalid token fields do not prevent finding another valid source', async () => {
  await save('.codex/.credentials.json', {
    injected: { server_url: MCP, access_token: 'unsafe\r\nheader' },
    invalidExpiry: { server_url: MCP, access_token: 'a', expires_at: 'not-a-date' },
    empty: { server_url: MCP, access_token: '' },
  });
  await save('.claude/.credentials.json', { mcpOAuth: { valid: { serverUrl: MCP, accessToken: 'good' } } });
  assert.deepEqual((await savedCredentials(home, MCP)).map(item => item.tokens.access_token), ['good']);
  await writeFile(join(home, '.codex/.credentials.json'), '{bad-json');
  assert.deepEqual((await savedCredentials(home, MCP)).map(item => item.tokens.access_token), ['good']);
});

function treeName(value: string, max = 250): string {
  return `S_${value.replace(/[^A-Za-z0-9_]+/g, '_').slice(0, max - 11)}-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

test('reads the Kimi FastMCP file cache using its resource key and absolute token expiry', async () => {
  const dir = `.kimi/mcp-oauth/${treeName('mcp-oauth-token', 245)}`;
  const expires = Date.now() + 120_000;
  await save(`${dir}/${treeName(`${MCP}/tokens`)}.json`, {
    value: { access_token: 'kimi-access', refresh_token: 'kimi-refresh', token_type: 'Bearer', expires_in: 60 },
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    expires_at: new Date(Date.now() + 365 * 86400_000).toISOString(),
  });
  await save(`.kimi/mcp-oauth/${treeName('mcp-oauth-token-expiry', 245)}/${treeName(`${MCP}/token_expiry`)}.json`, { value: { expires_at: expires / 1000 } });
  const [found] = await savedCredentials(home, MCP);
  assert.deepEqual(found, { provider: 'kimi', id: '.kimi', tokens: { access_token: 'kimi-access', expires_at: expires } });
  assert.deepEqual(await savedCredentials(home, 'https://mcp.example.com/other'), []);
});

test('Kimi uses creation time for relative expiry; cache lifetime does not make a stale token fresh', async () => {
  const created = Date.now() - 3600_000;
  const path = `.kimi-code/mcp-oauth/${treeName('mcp-oauth-token', 245)}/${treeName(`${MCP}/tokens`)}.json`;
  await save(path, { value: JSON.stringify({ access_token: 'old', expires_in: 60 }), created_at: new Date(created).toISOString(), expires_at: new Date(Date.now() + 86400_000).toISOString() });
  assert.equal((await savedCredentials(home, MCP))[0]?.tokens.expires_at, created + 60_000);
  await save(path, { value: { access_token: 'unknown-age', expires_in: 60 } });
  assert.deepEqual(await savedCredentials(home, MCP), []);
});

test('recognizes the exact filenames written by Kimi FastMCP, including collapsed URL punctuation', async () => {
  // Captured from TokenStorageAdapter.set_tokens against a temporary native FileTreeStore.
  await save('.kimi/mcp-oauth/S_mcp_oauth_token-3a009b34/S_https_mcp_example_com_v1_mcp_tokens-c99a1660.json', {
    value: { access_token: 'native-format', token_type: 'Bearer', expires_in: 3600, refresh_token: null, scope: null },
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 365 * 86400_000).toISOString(),
    version: 1,
  });
  const [found] = await savedCredentials(home, MCP);
  assert.equal(found?.tokens.access_token, 'native-format');
  assert.ok(found.tokens.expires_at! > Date.now());
});
