import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { CodexSignIns } from '../server/codex-sign-in';
import { SignIns } from '../server/oauth';
import { SharedTools } from '../server/service';

const MCP = 'https://mcp.example.com/mcp';
const REDIRECT = 'http://127.0.0.1:45000/callback';
const AUTH = `https://auth.example.com/authorize?response_type=code&client_id=client&state=test-state&code_challenge=challenge&redirect_uri=${encodeURIComponent(REDIRECT)}`;
const CALLBACK = `${REDIRECT}?code=test-code&state=test-state`;
let root: string;
const sessions: CodexSignIns[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'codex-mcp-login-')); });
afterEach(async () => {
  for (const session of sessions.splice(0)) session.stop();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); }
  }
  await rm(root, { recursive: true, force: true });
});

async function script(text: string) {
  const path = join(root, `cli-${Math.random().toString(36).slice(2)}.cjs`);
  await writeFile(path, text);
  return path;
}
async function client(options: { body?: string; authorized?: () => Promise<void>; ttl?: number } = {}) {
  const path = await script(options.body ?? `
    process.stdout.write(${JSON.stringify(AUTH.slice(0, 55))});
    process.stderr.write(${JSON.stringify('An unrelated warning\n')});
    setTimeout(() => process.stdout.write(${JSON.stringify(AUTH.slice(55) + '\nCallback URL (input hidden): ')}), 10);
    require('node:readline').createInterface({input:process.stdin}).once('line', line => {
      setTimeout(() => process.exit(line === ${JSON.stringify(CALLBACK)} ? 0 : 1), 10);
    });
  `);
  const launches: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const session = new CodexSignIns(root, options.authorized ?? (async () => undefined), (args, env) => {
    launches.push({ args, env });
    const child = spawn(process.execPath, [path], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  }, options.ttl);
  sessions.push(session);
  return { session, launches };
}

test('uses temporary CLI configuration, parses a split authorization link, submits the callback and verifies credentials', async () => {
  let completed = 0;
  const { session, launches } = await client({ authorized: async () => { completed++; } });
  const started = await session.start('files', { type: 'http', url: MCP, headers: { 'X-Tenant': 'a "quoted" value' } });
  assert.equal(started.authorizationUrl, AUTH);
  assert.equal(started.redirectUri, REDIRECT);
  assert.equal(started.via, 'codex');
  assert.equal(started.listening, false);
  assert.equal(launches[0]?.env.CODEX_HOME, join(root, '.codex'));
  assert.deepEqual(launches[0]?.args.slice(-4), ['mcp', 'login', 'files', '--no-browser']);
  assert.match(launches[0]!.args[1]!, /^mcp_servers\.files=\{ url = /);
  assert.ok(launches[0]!.args[1]!.includes('"X-Tenant" = "a \\"quoted\\" value"'));
  assert.equal(session.status('files')?.status, 'pending');
  await Promise.all([session.finish('files', CALLBACK), session.finish('files', CALLBACK)]);
  assert.equal(completed, 1);
  assert.deepEqual(session.status('files'), { status: 'done' });
});

test('rejects mismatched states, callback targets and multiline input before writing to the CLI', async () => {
  const { session } = await client();
  await session.start('files', { type: 'http', url: MCP });
  await assert.rejects(session.finish('files', CALLBACK.replace('test-state', 'other')), /another authorization/);
  await assert.rejects(session.finish('files', CALLBACK.replace('45000', '45001')), /callback URL/);
  await assert.rejects(session.finish('files', `${CALLBACK}\n${CALLBACK}`), /one complete/);
  await session.finish('files', CALLBACK);
  assert.equal(session.status('files')?.status, 'done');
});

test('accepts an authorization URL printed on stderr', async () => {
  const { session } = await client({ body: `
    process.stderr.write(${JSON.stringify(AUTH + '\n')});
    require('node:readline').createInterface({input:process.stdin}).once('line', () => process.exit(0));
  ` });
  assert.equal((await session.start('files', { type: 'http', url: MCP })).authorizationUrl, AUTH);
  await session.finish('files', CALLBACK);
});

test('cancel and timeout terminate a waiting CLI even before it prints a link', async () => {
  const waiting = 'setInterval(() => {}, 1000);';
  const { session } = await client({ body: waiting });
  const started = session.start('files', { type: 'http', url: MCP });
  const exited = once(children.at(-1)!, 'close');
  session.cancel('files');
  await assert.rejects(started, /cancelled/);
  await exited;
  assert.equal(session.status('files'), null);
  const timed = await client({ body: waiting, ttl: 100 });
  await assert.rejects(timed.session.start('files', { type: 'http', url: MCP }), /timed out/);
  assert.equal(timed.session.status('files')?.status, 'failed');
});

test('does not expose raw CLI output when login or credential verification fails', async () => {
  const failed = await client({ body: 'process.stderr.write("sensitive-cli-output"); process.exit(1);' });
  await assert.rejects(failed.session.start('files', { type: 'http', url: MCP }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /authorization failed/);
    assert.equal(error.message.includes('sensitive-cli-output'), false);
    return true;
  });
  const verifyFailed = await client({ authorized: async () => { throw new Error('private-token-detail'); } });
  await verifyFailed.session.start('files', { type: 'http', url: MCP });
  await assert.rejects(verifyFailed.session.finish('files', CALLBACK), /credential could not be reused/);
  assert.equal(JSON.stringify(verifyFailed.session.status('files')).includes('private-token-detail'), false);
});

test('refuses stdio, SSE, explicit Authorization and invalid server names', async () => {
  const { session, launches } = await client();
  await assert.rejects(session.start('files', { type: 'stdio', command: 'x' }), /HTTP/);
  await assert.rejects(session.start('files', { type: 'sse', url: MCP }), /HTTP/);
  await assert.rejects(session.start('files', { type: 'http', url: MCP, headers: { authorization: 'Bearer manual' } }), /HTTP/);
  await assert.rejects(session.start('bad.name', { type: 'http', url: MCP }), /Invalid/);
  assert.equal(launches.length, 0);
});

test('SharedTools routes Codex callbacks and polling through the CLI flow and stops it on unload', async () => {
  let authorized = false;
  const { session } = await client({ authorized: async () => { authorized = true; } });
  const shared = join(root, 'shared');
  const tools = new SharedTools(shared, root, () => undefined, new SignIns(shared, () => undefined, fetch, false, root), session);
  await tools.saveServer({ previousName: null, name: 'files', config: { type: 'http', url: MCP }, enabled: true, providers: null });
  assert.equal((await tools.startSignIn('files', false, 'codex')).via, 'codex');
  assert.equal(tools.signInStatus('files').status, 'pending');
  await tools.finishSignIn('files', CALLBACK);
  assert.equal(authorized, true);
  assert.equal(tools.signInStatus('files').status, 'done');
  tools.stop();
  assert.equal(tools.signInStatus('files').status, 'none');
});
