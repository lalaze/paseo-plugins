import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsKimiRefresh, createCredentialRefresher, renewWithKimi, portsFromBanner } from '../src/kimi-refresh.js';
import { locate, ROOT, sha } from '../patch.mjs';
import { patchedKimi, checkKimi, applyKimi, rollbackKimi, kimiFixture } from '../kimi-patch.mjs';
const target = locate(process.env.PASEO_PATCH_TEST_CLI);
const now = 1_800_000_000_000;
const credentials = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_at: now / 1000 - 1 };

test('only near-expiry renewable OAuth credentials trigger renewal', () => {
  assert.equal(needsKimiRefresh(credentials, now), true);
  assert.equal(needsKimiRefresh({ ...credentials, expires_at: now / 1000 + 301 }, now), false);
  assert.equal(needsKimiRefresh({ ...credentials, expires_at: now / 1000 + 300 }, now), true);
  for (const c of [{}, { access_token: 'static' }, { ...credentials, refresh_token: '' }, { ...credentials, expires_at: NaN }]) assert.equal(needsKimiRefresh(c, now), false);
});
test('parses uvicorn and kimi-code listen banners without tokens', () => {
  assert.deepEqual(portsFromBanner('INFO:     Uvicorn running on http://127.0.0.1:5494 (Press CTRL+C to quit)\n'), [5494]);
  assert.deepEqual(portsFromBanner('Local:   http://127.0.0.1:58627/#token=secret\n'), [58627]);
});
test('concurrent callers renew once, transient failures cool down and retry', async () => {
  let clock = now, calls = 0, fails = true;
  const run = async () => { calls++; await new Promise(r => setTimeout(r, 10)); if (fails) throw new Error('private'); };
  const refresh = createCredentialRefresher({ run, now: () => clock });
  await Promise.all([refresh('/synthetic', credentials), refresh('/synthetic', credentials), refresh('/synthetic', credentials)]);
  assert.equal(calls, 1);
  await refresh('/synthetic', credentials);
  assert.equal(calls, 1);
  clock += 60001; fails = false;
  await refresh('/synthetic', credentials);
  assert.equal(calls, 2);
  await refresh('/synthetic', { ...credentials, expires_at: clock / 1000 + 900 });
  assert.equal(calls, 2);
});
test('official endpoint path: isolated loopback child and cleanup on success', async () => {
  const child = new EventEmitter(); child.pid = 424242;
  const signals = [];
  await renewWithKimi('/synthetic/credentials/kimi-code.json', {
    bin: '/synthetic/bin/kimi',
    spawn: (bin, args, options) => {
      assert.equal(bin, '/synthetic/bin/kimi');
      assert.deepEqual(args, ['web', '--no-open', '--host', '127.0.0.1']);
      assert.equal(options.env.KIMI_CODE_HOME, '/synthetic');
      assert.equal(options.stdio, 'ignore'); assert.equal(options.detached, true);
      return child;
    },
    ports: async () => [12345], readToken: async () => 'synthetic-server-token',
    query: async (port, token) => { assert.equal(port, 12345); assert.equal(token, 'synthetic-server-token'); return true; },
    killGroup: (pid, signal) => { assert.equal(pid, -424242); signals.push(signal); child.emit('exit', 0); },
  });
  assert.deepEqual(signals, ['SIGTERM']);
});
test('unresponsive child is time-bounded and only its process group is killed', async () => {
  const child = new EventEmitter(); child.pid = 424243;
  let clock = 0;
  const signals = [];
  await assert.rejects(renewWithKimi('/synthetic/credentials/kimi-code.json', {
    bin: '/synthetic/bin/kimi', spawn: () => child, ports: async () => [], readToken: async () => '',
    now: () => clock, timeoutMs: 100, sleep: async ms => { clock += ms; },
    killGroup: (pid, signal) => { assert.equal(pid, -424243); signals.push(signal); },
  }), /unavailable/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(clock <= 700);
});
test('spawn errors fail without trying to signal another process', async () => {
  const child = new EventEmitter();
  await assert.rejects(renewWithKimi('/synthetic/credentials/kimi-code.json', {
    bin: '/missing', spawn: () => { queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child; },
    ports: async () => [], readToken: async () => '', sleep: async () => {},
    killGroup: () => assert.fail('must not signal undefined pid'),
  }), /unavailable/);
});

test('Kimi patch apply, idempotence, drift refusal and exact independent rollback', () => {
  const base = 'dist/server/services/quota-fetcher/providers';
  const dir = mkdtempSync(join(tmpdir(), 'kimi-install-test-'));
  const t = { ...target, server: dir };
  const state = join(ROOT, '.state', `kimi-${sha(dir).slice(0, 20)}.json`);
  try {
    mkdirSync(join(dir, base), { recursive: true });
    cpSync(join(target.server, base, '../usage.js'), join(dir, base, '../usage.js'));
    let original = readFileSync(join(target.server, base, 'kimi.js'), 'utf8');
    if (original.startsWith('// paseo-agy-quote:kimi-refresh')) original = JSON.parse(readFileSync(join(ROOT, '.state', `kimi-${sha(target.server).slice(0, 20)}.json`), 'utf8')).before;
    const file = join(dir, base, 'kimi.js'); writeFileSync(file, original);
    assert.equal(checkKimi(t).installed, false);
    applyKimi(t, { runTests: false });
    assert.equal(checkKimi(t).installed, true);
    assert.match(applyKimi(t, { runTests: false }), /already/);
    const patched = readFileSync(file, 'utf8');
    writeFileSync(file, patched + '// unrelated change');
    assert.throws(() => rollbackKimi(t), /refusing/);
    writeFileSync(file, patched); rollbackKimi(t);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(existsSync(join(dir, base, 'kimi-refresh.js')), false);
    writeFileSync(file, original + '// upstream update');
    assert.throws(() => applyKimi(t, { runTests: false }), /Incompatible/);
    assert.throws(() => patchedKimi('unknown implementation'), /changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(state, { force: true }); }
});

test('Kimi apply upgrades a managed stale helper without rewriting kimi.js', () => {
  const base = 'dist/server/services/quota-fetcher/providers';
  const dir = mkdtempSync(join(tmpdir(), 'kimi-helper-upgrade-'));
  const t = { ...target, server: dir };
  const state = join(ROOT, '.state', `kimi-${sha(dir).slice(0, 20)}.json`);
  try {
    mkdirSync(join(dir, base), { recursive: true });
    cpSync(join(target.server, base, '../usage.js'), join(dir, base, '../usage.js'));
    let original = readFileSync(join(target.server, base, 'kimi.js'), 'utf8');
    if (original.startsWith('// paseo-agy-quote:kimi-refresh')) original = JSON.parse(readFileSync(join(ROOT, '.state', `kimi-${sha(target.server).slice(0, 20)}.json`), 'utf8')).before;
    const file = join(dir, base, 'kimi.js');
    const helper = join(dir, base, 'kimi-refresh.js');
    writeFileSync(file, original);
    applyKimi(t, { runTests: false });
    const patched = readFileSync(file, 'utf8');
    writeFileSync(helper, readFileSync(helper, 'utf8') + '\n');
    const recorded = JSON.parse(readFileSync(state, 'utf8'));
    recorded.helperHash = sha(readFileSync(helper));
    writeFileSync(state, JSON.stringify(recorded, null, 2));
    assert.equal(checkKimi(t).installed, true);
    assert.equal(checkKimi(t).helperStale, true);
    assert.match(applyKimi(t, { runTests: false }), /updated/);
    assert.equal(readFileSync(file, 'utf8'), patched);
    assert.equal(sha(readFileSync(helper)), sha(readFileSync(join(ROOT, 'src/kimi-refresh.js'))));
    assert.match(applyKimi(t, { runTests: false }), /already/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(state, { force: true }); }
});

const fixture = kimiFixture(target);
after(() => fixture.cleanup());
const { KimiQuotaProvider } = await import(fixture.module);
const logger = { child() { return this; }, debug() {} };
test('integration uses newly reread credentials and preserves static env keys', async () => {
  const oldToken = process.env.KIMI_TOKEN, oldKey = process.env.KIMI_API_KEY;
  delete process.env.KIMI_TOKEN; delete process.env.KIMI_API_KEY;
  try {
    const p = new KimiQuotaProvider({ logger });
    let reads = 0;
    p.credentialPaths = () => ['/synthetic'];
    p.readCredentialFile = async () => ({ access_token: ++reads === 1 ? 'old' : 'renewed' });
    assert.equal((await p.readCredentials()).access_token, 'renewed');
    assert.equal(reads, 2);
    process.env.KIMI_TOKEN = 'static-env';
    assert.equal((await p.readCredentials()).access_token, 'static-env');
    assert.equal(reads, 2);
  } finally {
    if (oldToken === undefined) delete process.env.KIMI_TOKEN; else process.env.KIMI_TOKEN = oldToken;
    if (oldKey === undefined) delete process.env.KIMI_API_KEY; else process.env.KIMI_API_KEY = oldKey;
  }
});
