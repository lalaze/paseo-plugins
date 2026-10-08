import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { bearerParams, discover, parseCallback, REDIRECT_URI, SignIns } from '../server/oauth';
import { SharedTools, type Paseo } from '../server/service';

const MCP = 'https://mcp.example.com/v1/mcp';

/** A resource server at mcp.example.com and an authorization server at auth.example.com/tenant. */
function fakeServers(options: { expiresIn?: number; rotate?: boolean } = {}) {
  const calls: { url: string; body: string | null }[] = [];
  let issued = 0;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url, body });
    if (url === MCP) return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp", scope="files:read"' });
    if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp') {
      return json(200, { resource: MCP, authorization_servers: ['https://auth.example.com/tenant'], scopes_supported: ['files:read', 'files:write'] });
    }
    if (url === 'https://auth.example.com/.well-known/oauth-authorization-server/tenant') {
      return json(200, {
        issuer: 'https://auth.example.com/tenant', authorization_endpoint: 'https://auth.example.com/tenant/authorize',
        token_endpoint: 'https://auth.example.com/tenant/token', registration_endpoint: 'https://auth.example.com/tenant/register',
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url === 'https://auth.example.com/tenant/register') return json(201, { client_id: 'client-1' });
    if (url === 'https://auth.example.com/tenant/token') {
      const params = new URLSearchParams(body ?? '');
      issued += 1;
      if (params.get('grant_type') === 'authorization_code' && params.get('code') !== 'good-code') return json(400, { error: 'invalid_grant', error_description: 'bad code' });
      return json(200, {
        access_token: `access-${issued}`, token_type: 'Bearer', scope: 'files:read',
        ...(options.expiresIn !== undefined ? { expires_in: options.expiresIn } : {}),
        ...(params.get('grant_type') === 'authorization_code' || options.rotate ? { refresh_token: `refresh-${issued}` } : {}),
      });
    }
    return json(404, {});
  }) as typeof fetch;
  return { fetcher, calls };
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'shared-tools-oauth-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('reads the parameters of a Bearer challenge', () => {
  assert.deepEqual(bearerParams('Bearer realm="a b", resource_metadata="https://x/y", error=invalid_token'), { realm: 'a b', resource_metadata: 'https://x/y', error: 'invalid_token' });
  assert.deepEqual(bearerParams(null), {});
});

test('finds the authorization server through the resource metadata the 401 names', async () => {
  const { fetcher } = fakeServers();
  const found = await discover({ type: 'http', url: MCP }, fetcher);
  assert.equal(found.resource, MCP);
  assert.equal(found.server.token_endpoint, 'https://auth.example.com/tenant/token');
  assert.equal(found.scope, 'files:read');
});

test('a server that answers without a challenge does not need sign-in', async () => {
  const fetcher = (async (input: string | URL) => new Response('{}', { status: String(input).includes('/.well-known/') ? 404 : 200 })) as typeof fetch;
  await assert.rejects(discover({ type: 'http', url: 'https://open.example.com/mcp' }, fetcher), /does not ask for sign-in/);
});

test('reads the pasted address, or a bare code', () => {
  assert.deepEqual(parseCallback(`  ${REDIRECT_URI}?code=abc&state=s1 `), { code: 'abc', state: 's1' });
  assert.deepEqual(parseCallback('abc'), { code: 'abc', state: null });
  assert.throws(() => parseCallback(`${REDIRECT_URI}?error=access_denied&error_description=No`), /refused: No/);
  assert.throws(() => parseCallback(`${REDIRECT_URI}?state=s1`), /no "code"/);
  assert.throws(() => parseCallback(''), /Paste/);
});

test('signs in with PKCE and a registered client, then hands out the token', async () => {
  const { fetcher, calls } = fakeServers({ expiresIn: 3600 });
  const signIns = new SignIns(root, () => undefined, fetcher, false);
  const started = await signIns.start('files', { type: 'http', url: MCP });
  assert.equal(started.listening, false);
  const authorize = new URL(started.authorizationUrl);
  assert.equal(authorize.origin + authorize.pathname, 'https://auth.example.com/tenant/authorize');
  assert.equal(authorize.searchParams.get('client_id'), 'client-1');
  assert.equal(authorize.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('resource'), MCP);
  assert.equal(signIns.status('files').status, 'pending');

  const state = authorize.searchParams.get('state')!;
  await assert.rejects(signIns.finish('other', `${REDIRECT_URI}?code=good-code&state=${state}`), /for "files"/);
  await assert.rejects(signIns.finish('files', `${REDIRECT_URI}?code=bad&state=${state}`), /bad code/);
  await signIns.finish('files', `${REDIRECT_URI}?code=good-code&state=${state}`);
  assert.equal(signIns.status('files').status, 'done');
  const exchange = new URLSearchParams(calls.findLast(call => call.url.endsWith('/token'))!.body!);
  assert.equal(exchange.get('code_verifier')?.length, 43);
  assert.equal(exchange.get('resource'), MCP);

  assert.equal(await signIns.header('files', { type: 'http', url: MCP }), 'Bearer access-2');
  // A server with its own header, or one whose URL has changed since, does not get the token.
  assert.equal(await signIns.header('files', { type: 'http', url: MCP, headers: { authorization: 'Bearer mine' } }), null);
  assert.equal(await signIns.header('files', { type: 'http', url: 'https://elsewhere/mcp' }), null);
  assert.deepEqual(Object.keys(signIns.statuses({ files: { type: 'http', url: MCP } })), ['files']);
  assert.deepEqual(signIns.statuses({ files: { type: 'http', url: 'https://elsewhere/mcp' } }), {});

  const file = join(root, 'oauth.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).servers.files.tokens.refresh_token, 'refresh-2');
  signIns.stop();
});

test('refreshes a token that is about to run out, once for concurrent agents', async () => {
  const { fetcher, calls } = fakeServers({ expiresIn: 60 });
  const signIns = new SignIns(root, () => undefined, fetcher, false);
  const started = new URL((await signIns.start('files', { type: 'http', url: MCP })).authorizationUrl);
  await signIns.finish('files', `${REDIRECT_URI}?code=good-code&state=${started.searchParams.get('state')}`);
  const before = calls.length;
  const headers = await Promise.all([signIns.header('files', { type: 'http', url: MCP }), signIns.header('files', { type: 'http', url: MCP })]);
  assert.deepEqual(headers, ['Bearer access-2', 'Bearer access-2']);
  const refreshes = calls.slice(before).filter(call => call.url.endsWith('/token'));
  assert.equal(refreshes.length, 1);
  assert.equal(new URLSearchParams(refreshes[0]!.body!).get('refresh_token'), 'refresh-1');

  // A fresh instance reads what was saved, keeping the refresh token the server did not rotate.
  const reloaded = new SignIns(root, () => undefined, fetcher, false);
  assert.equal((await reloaded.load()).files!.tokens.refresh_token, 'refresh-1');
  signIns.stop();
});

test('new agents get the shared server with the sign-in header', async () => {
  const { fetcher } = fakeServers();
  const home = join(root, 'home');
  const tools = new SharedTools(join(home, '.paseo/shared-tools'), home, () => undefined, new SignIns(join(home, '.paseo/shared-tools'), () => undefined, fetcher, false));
  const paseo = {
    providers: { snapshot: async () => ({ entries: [{ provider: 'claude', status: 'ready', enabled: true, label: 'Claude' }] }) },
    config: { get: async () => ({ requestId: 'r', config: { providers: {} } }) },
  } as unknown as Paseo;
  await tools.state(paseo);
  await tools.saveServer({ previousName: null, name: 'files', enabled: true, providers: null, config: { type: 'http', url: MCP } });
  const started = new URL((await tools.startSignIn('files')).authorizationUrl);
  const state = await tools.finishSignIn('files', `${REDIRECT_URI}?code=good-code&state=${started.searchParams.get('state')}`);
  assert.equal(state.auth.files?.status, 'signed-in');
  assert.deepEqual(await tools.mcpFor('claude', undefined, paseo), { files: { type: 'http', url: MCP, headers: { Authorization: 'Bearer access-1' } } });

  // Renaming keeps the sign-in; signing out drops it.
  await tools.saveServer({ previousName: 'files', name: 'drive', enabled: true, providers: null, config: { type: 'http', url: MCP } });
  assert.equal((await tools.mcpFor('claude', undefined, paseo))?.drive?.type, 'http');
  assert.deepEqual(Object.keys((await tools.signOut('drive')).auth), []);
  assert.deepEqual(await tools.mcpFor('claude', undefined, paseo), { drive: { type: 'http', url: MCP } });
  tools.stop();
});

async function codexCredentials(access: string, expires = Date.now() + 3600_000) {
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.codex/.credentials.json'), JSON.stringify({
    'different-name|hash': { server_url: MCP, access_token: access, expires_at: expires, refresh_token: 'owned-by-codex', client_id: 'native-client' },
  }));
}

test('links existing native authorization without registering and observes native refresh and sign-out', async () => {
  await codexCredentials('native-access');
  const calls: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer native-access');
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const signIns = new SignIns(join(root, 'shared'), () => undefined, fetcher, false, root);
  assert.equal(await signIns.reuse('files', { type: 'http', url: MCP }), 'Codex');
  assert.deepEqual(calls, [MCP]);
  assert.equal(await signIns.header('files', { type: 'http', url: MCP }), 'Bearer native-access');
  assert.equal(signIns.statuses({ files: { type: 'http', url: MCP } }).files?.source, 'Codex');
  const saved = await readFile(join(root, 'shared/oauth.json'), 'utf8');
  assert.equal(saved.includes('native-access'), false);
  assert.equal(saved.includes('owned-by-codex'), false);
  assert.equal((await stat(join(root, 'shared/oauth.json'))).mode & 0o777, 0o600);

  await codexCredentials('refreshed-by-codex');
  const reloaded = new SignIns(join(root, 'shared'), () => undefined, fetcher, false, root);
  assert.equal(await reloaded.header('files', { type: 'http', url: MCP }), 'Bearer refreshed-by-codex');
  assert.equal(await reloaded.header('files', { type: 'http', url: `${MCP}?other` }), null);
  assert.equal(await reloaded.header('files', { type: 'http', url: MCP, headers: { Authorization: 'Bearer explicit' } }), null);
  await reloaded.rename('files', 'renamed');
  assert.equal(await reloaded.header('renamed', { type: 'http', url: MCP }), 'Bearer refreshed-by-codex');
  await codexCredentials('expired', Date.now() - 1);
  assert.equal(await reloaded.header('renamed', { type: 'http', url: MCP }), null);
  assert.equal(reloaded.statuses({ renamed: { type: 'http', url: MCP } }).renamed?.status, 'expired');
  await rm(join(root, '.codex/.credentials.json'));
  await reloaded.readSources();
  assert.equal(await reloaded.header('renamed', { type: 'http', url: MCP }), null);
  await reloaded.signOut('renamed');
  assert.deepEqual(reloaded.statuses({ renamed: { type: 'http', url: MCP } }), {});
  signIns.stop();
  reloaded.stop();
});

test('rejects expired native tokens even with refresh tokens, and does not refresh the originating client', async () => {
  await codexCredentials('expired', Date.now() - 1);
  const fetcher = (async () => { assert.fail('An expired borrowed token must never be sent or refreshed'); }) as typeof fetch;
  const signIns = new SignIns(join(root, 'shared'), () => undefined, fetcher, false, root);
  await assert.rejects(signIns.reuse('files', { type: 'http', url: MCP }), /Codex.*expired/);
  assert.deepEqual(signIns.statuses({ files: { type: 'http', url: MCP } }), {});
});

test('tries another client when the first token has been revoked, without modifying either cache', async () => {
  await codexCredentials('revoked', Date.now() + 7200_000);
  await mkdir(join(root, '.claude'), { recursive: true });
  const claude = JSON.stringify({ mcpOAuth: { entry: { serverUrl: MCP, accessToken: 'working', expiresAt: Date.now() + 3600_000 } } });
  await writeFile(join(root, '.claude/.credentials.json'), claude);
  const fetcher = (async (_input: string | URL, init?: RequestInit) => new Response('{}', {
    status: new Headers(init?.headers).get('Authorization') === 'Bearer working' ? 200 : 401,
  })) as typeof fetch;
  const signIns = new SignIns(join(root, 'shared'), () => undefined, fetcher, false, root);
  assert.equal(await signIns.reuse('files', { type: 'http', url: MCP }), 'Claude Code');
  assert.equal(await signIns.header('files', { type: 'http', url: MCP }), 'Bearer working');
  assert.equal(await readFile(join(root, '.claude/.credentials.json'), 'utf8'), claude);
});

test('the sign-in RPC reuses a native authorization; browser sign-in can explicitly bypass discovery', async () => {
  await codexCredentials('native');
  const fake = fakeServers();
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    if (String(input) === MCP && new Headers(init?.headers).has('Authorization')) return new Response('{}');
    return fake.fetcher(input, init);
  }) as typeof fetch;
  const shared = join(root, 'shared');
  const tools = new SharedTools(shared, root, () => undefined, new SignIns(shared, () => undefined, fetcher, false, root));
  await tools.saveServer({ previousName: null, name: 'files', enabled: true, providers: null, config: { type: 'http', url: MCP } });
  const started = await tools.startSignIn('files');
  assert.equal(started.reused, true);
  assert.equal(started.source, 'Codex');
  assert.equal(started.authorizationUrl, '');
  const browser = await tools.startSignIn('files', false);
  assert.equal(new URL(browser.authorizationUrl).searchParams.get('client_id'), 'client-1');
  assert.equal(fake.calls.filter(call => call.url.endsWith('/register')).length, 1);
  tools.stop();
});

test('keeps the verified cache entry when one client has multiple authorizations for the same URL', async () => {
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.codex/.credentials.json'), JSON.stringify({
    revoked: { server_url: MCP, access_token: 'revoked', expires_at: Date.now() + 7200_000 },
    valid: { server_url: MCP, access_token: 'valid', expires_at: Date.now() + 3600_000 },
  }));
  const fetcher = (async (_input: string | URL, init?: RequestInit) => new Response('{}', {
    status: new Headers(init?.headers).get('Authorization') === 'Bearer valid' ? 200 : 401,
  })) as typeof fetch;
  const shared = join(root, 'shared');
  const signIns = new SignIns(shared, () => undefined, fetcher, false, root);
  assert.equal(await signIns.reuse('files', { type: 'http', url: MCP }), 'Codex');
  assert.equal(await signIns.header('files', { type: 'http', url: MCP }), 'Bearer valid');
  const reloaded = new SignIns(shared, () => undefined, fetcher, false, root);
  assert.equal(await reloaded.header('files', { type: 'http', url: MCP }), 'Bearer valid');
  await writeFile(join(root, '.codex/.credentials.json'), JSON.stringify({ revoked: { server_url: MCP, access_token: 'revoked' } }));
  assert.equal(await reloaded.header('files', { type: 'http', url: MCP }), null);
});
