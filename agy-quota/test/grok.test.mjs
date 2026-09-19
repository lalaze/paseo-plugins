import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { needsGrokRefresh, createGrokRefresher, renewWithGrok } from '../src/grok-refresh.js';
import { locate, ROOT, sha } from '../patch.mjs';
import { grokFixture, checkGrok, applyGrok, rollbackGrok, recoverGrok, unpatchedGrok } from '../grok-patch.mjs';

const now = Date.now();
const stale = { key: 'synthetic-old', auth_mode: 'oidc', refresh_token: 'synthetic-refresh', expires_at: new Date(now - 1000).toISOString() };
const fresh = { ...stale, key: 'synthetic-new', expires_at: new Date(now + 3600000).toISOString() };
const auth = credential => ({ 'https://auth.x.ai::test': credential });
const extract = value => value.access_token || value['https://auth.x.ai::test']?.key || null;
const target = locate(process.env.PASEO_PATCH_TEST_CLI);

test('renew only the selected, near-expiry OAuth credential', () => {
  assert.equal(needsGrokRefresh(auth(stale), extract, now), true);
  assert.equal(needsGrokRefresh(auth(fresh), extract, now), false);
  for (const value of [auth({ ...stale, refresh_token: '' }), auth({ ...stale, expires_at: 'invalid' }), auth({ ...stale, auth_mode: 'api_key' }), { ...auth(stale), access_token: 'legacy-static' }]) {
    assert.equal(needsGrokRefresh(value, extract, now), false);
  }
});

test('coalesce renewal, reread credentials, cool down failures without exposing errors', async () => {
  let clock = now, calls = 0, fail = true, disk = auth(stale);
  const refresh = createGrokRefresher({ now: () => clock, read: async () => disk, run: async () => {
    calls++; await new Promise(r => setTimeout(r, 10));
    if (fail) throw new Error('secret refresh response');
    disk = auth(fresh);
  } });
  assert.deepEqual(await Promise.all([refresh('/auth', extract), refresh('/auth', extract)]), ['synthetic-old', 'synthetic-old']);
  assert.equal(calls, 1);
  assert.equal(await refresh('/auth', extract), 'synthetic-old');
  assert.equal(calls, 1);
  clock += 60001; fail = false;
  assert.equal(await refresh('/auth', extract), 'synthetic-new');
  assert.equal(calls, 2);
  assert.equal(await refresh('/auth', extract), 'synthetic-new');
  assert.equal(calls, 2);
});

function childFixture() {
  const child = new EventEmitter(); child.pid = 424242; child.stdin = new PassThrough();
  return child;
}

test('official CLI initialization refreshes without a session or prompt; cleans private process group', async () => {
  const child = childFixture(), signals = [];
  let request = '';
  child.stdin.on('data', c => { request += c; });
  await renewWithGrok('/synthetic/auth.json', extract, {
    bin: '/synthetic/bin/grok',
    spawn: (bin, args, options) => {
      assert.deepEqual(args, ['agent', '--no-leader', 'stdio']);
      assert.equal(options.env.GROK_AUTH_PATH, '/synthetic/auth.json');
      assert.equal(options.env.GROK_HOME, '/synthetic');
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, ['pipe', 'ignore', 'ignore']);
      return child;
    },
    read: async () => auth(fresh),
    sleep: async () => {},
    killGroup: (pid, signal) => { assert.equal(pid, -child.pid); signals.push(signal); child.emit('exit', 0); },
  });
  assert.equal(JSON.parse(request).method, 'initialize');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('unresponsive or failed child is bounded, never reports success without fresh credentials', async () => {
  const child = childFixture(), signals = [];
  let clock = now;
  await assert.rejects(renewWithGrok('/synthetic/auth.json', extract, {
    bin: '/synthetic/bin/grok', spawn: () => child, read: async () => auth(stale),
    now: () => clock, timeoutMs: 100, sleep: async ms => { clock += ms; },
    killGroup: (pid, signal) => signals.push(signal),
  }), /unavailable/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(clock - now <= 700);
  const failed = childFixture(); failed.pid = undefined;
  await assert.rejects(renewWithGrok('/synthetic/auth.json', extract, {
    bin: '/missing', spawn: () => { queueMicrotask(() => failed.emit('error', new Error('ENOENT'))); return failed; },
    read: async () => auth(stale), sleep: async () => {},
    killGroup: () => assert.fail('must not signal a process without a PID'),
  }), /unavailable/);
});

test('provider sends the renewed token to billing; valid credentials and API keys never spawn CLI', async () => {
  const fixture = grokFixture(target);
  const home = mkdtempSync(join(tmpdir(), 'grok-auth-test-'));
  const saved = Object.fromEntries(['PASEO_GROK_BIN', 'GROK_API_KEY', 'GROK_TOKEN', 'GROK_HOME', 'GROK_AUTH_PATH'].map(k => [k, process.env[k]]));
  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    const dir = join(home, '.grok'); mkdirSync(dir);
    const path = join(dir, 'auth.json'), log = join(home, 'spawned');
    const fake = join(home, 'grok');
    writeFileSync(fake, `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'spawn\\n');fs.writeFileSync(process.env.GROK_AUTH_PATH,${JSON.stringify(JSON.stringify(auth(fresh)))});setInterval(()=>{},1000);`, { mode: 0o700 });
    process.env.PASEO_GROK_BIN = fake;
    const { GrokQuotaProvider } = await import(fixture.module);
    let expected = 'synthetic-new';
    const provider = new GrokQuotaProvider({ homeDir: home, logger: { debug() {} }, fetch: async (url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${expected}`);
      return new Response(JSON.stringify({ config: { creditUsagePercent: 37 } }), { status: 200 });
    } });
    writeFileSync(path, JSON.stringify(auth(stale)));
    assert.equal((await provider.fetchUsage()).windows[0].remainingPct, 63);
    await provider.fetchUsage();
    assert.equal(readFileSync(log, 'utf8'), 'spawn\n');
    process.env.GROK_API_KEY = expected = 'synthetic-env-key';
    writeFileSync(path, JSON.stringify(auth(stale)));
    await provider.fetchUsage();
    assert.equal(readFileSync(log, 'utf8'), 'spawn\n');
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v;
    fixture.cleanup(); rmSync(home, { recursive: true, force: true });
  }
});

test('patch installation is reversible, idempotent and refuses upstream drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-install-test-'));
  const t = { ...target, server: dir }, base = 'dist/server/services/quota-fetcher/providers';
  const state = join(ROOT, '.state', `grok-${sha(dir).slice(0, 20)}.json`);
  try {
    mkdirSync(join(dir, base), { recursive: true });
    cpSync(join(target.server, base, '../usage.js'), join(dir, base, '../usage.js'));
    let original = readFileSync(join(target.server, base, 'grok.js'), 'utf8');
    if (original.startsWith('// paseo-agy-quote:grok-refresh')) original = unpatchedGrok(original);
    const file = join(dir, base, 'grok.js'); writeFileSync(file, original);
    assert.equal(checkGrok(t).installed, false);
    applyGrok(t, { runTests: false });
    assert.equal(checkGrok(t).installed, true);
    assert.match(applyGrok(t, { runTests: false }), /already/);
    const patched = readFileSync(file, 'utf8');
    writeFileSync(file, patched + '// changed');
    assert.throws(() => rollbackGrok(t), /refusing/);
    writeFileSync(file, patched); rollbackGrok(t);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(existsSync(join(dir, base, 'grok-refresh.js')), false);
    applyGrok(t, { runTests: false }); rmSync(state);
    recoverGrok(t);
    assert.equal(readFileSync(file, 'utf8'), original);
    writeFileSync(file, original + '// upstream update');
    assert.throws(() => applyGrok(t, { runTests: false }), /Incompatible/);
  } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(state, { force: true });
  }
});
