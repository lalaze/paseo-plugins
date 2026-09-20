import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { locate, ROOT, sha } from '../patch.mjs';
import { applyClaude, checkClaude, claudeFixture, patchedClaude, rollbackClaude, unpatchedClaude } from '../claude-patch.mjs';
import { CLAUDE_QUOTA_INTERVAL_MS, retryAfterDeadline } from '../src/claude-quota-throttle.js';

const target = locate(process.env.PASEO_PATCH_TEST_CLI);
const { ProviderUsageService } = await import(pathToFileURL(join(target.server, 'dist/server/services/quota-fetcher/service.js')));
const logger = { child() { return this; }, debug() {}, warn() {} };
const base = 'dist/server/services/quota-fetcher/providers';
const start = Date.parse('2026-09-19T13:00:00Z');

async function fixture(fn, response = () => Response.json({ five_hour: { utilization: 25 } })) {
  const f = claudeFixture(target);
  const { ClaudeQuotaProvider } = await import(f.module);
  const clock = { time: start, calls: 0, token: 'fake-private-token' };
  const stateFile = join(f.dir, 'state', 'cooldown.json');
  const create = () => {
    const provider = new ClaudeQuotaProvider({
      logger,
      fetch: async () => { clock.calls++; return response(clock); },
      quotaFetchOptions: { now: () => clock.time, stateFile },
    });
    provider.readCredentials = async () => ({ oauth: { accessToken: clock.token, subscriptionType: 'pro' } });
    return provider;
  };
  try { await fn({ clock, stateFile, create, provider: create() }); }
  finally { f.cleanup(); }
}

test('real Claude reader limits five-minute daemon polls and forced refresh to 15 minutes', async () => {
  await fixture(async ({ clock, stateFile, provider }) => {
    const service = new ProviderUsageService({ logger, fetchers: [provider], now: () => clock.time });
    for (const minute of [0, 1, 5, 10, 14]) {
      clock.time = start + minute * 60000;
      const result = await service.listUsage({ forceRefresh: true });
      assert.equal(result.providers[0].windows[0].remainingPct, 75);
      assert.equal(clock.calls, 1);
    }
    clock.time = start + CLAUDE_QUOTA_INTERVAL_MS;
    await service.listUsage({ forceRefresh: true });
    assert.equal(clock.calls, 2);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { version: 1, nextAllowedAt: start + 2 * CLAUDE_QUOTA_INTERVAL_MS });
    assert.doesNotMatch(readFileSync(stateFile, 'utf8'), /fake-private-token|utilization|accessToken/);
  });
});

test('429 Retry-After blocks repeated daemon refreshes through the exact deadline', async () => {
  await fixture(async ({ clock, provider }) => {
    const service = new ProviderUsageService({ logger, fetchers: [provider], now: () => clock.time });
    for (const second of [0, 300, 900, 1800, 3203]) {
      clock.time = start + second * 1000;
      const result = await service.listUsage({ forceRefresh: true });
      assert.match(result.providers[0].error, /429/);
      assert.equal(clock.calls, 1);
    }
    clock.time = start + 3204000;
    await service.listUsage({ forceRefresh: true });
    assert.equal(clock.calls, 2);
  }, () => new Response('{}', { status: 429, headers: { 'Retry-After': '3204' } }));
});

test('HTTP-date, missing and malformed Retry-After are handled conservatively', () => {
  assert.equal(retryAfterDeadline(new Date(start + 7200000).toUTCString(), start), start + 7200000);
  assert.equal(retryAfterDeadline('10', start), start + CLAUDE_QUOTA_INTERVAL_MS);
  for (const value of [null, '', 'invalid', '-1']) assert.equal(retryAfterDeadline(value, start), start + 3600000);
});

test('cooldown survives a new provider instance without persisting credentials or quota', async () => {
  await fixture(async ({ clock, provider, create }) => {
    await assert.rejects(provider.fetchUsage(), /429/);
    const restarted = create();
    clock.time += 1800000;
    await assert.rejects(restarted.fetchUsage(), /paused until/);
    assert.equal(clock.calls, 1);
    clock.time = start + 3204000;
    await assert.rejects(restarted.fetchUsage(), /429/);
    assert.equal(clock.calls, 2);
  }, () => new Response('{}', { status: 429, headers: { 'Retry-After': '3204' } }));
});

test('concurrent calls share one request and each receives a readable response', async () => {
  await fixture(async ({ clock, provider }) => {
    const results = await Promise.all(Array.from({ length: 12 }, () => provider.fetchUsage()));
    assert.equal(clock.calls, 1);
    assert.ok(results.every(result => result.windows[0].remainingPct === 75));
  });
});

test('network errors do not cause repeated requests', async () => {
  await fixture(async ({ clock, provider }) => {
    await assert.rejects(provider.fetchUsage(), /network unavailable/);
    clock.time += 300000;
    await assert.rejects(provider.fetchUsage(), /paused until/);
    assert.equal(clock.calls, 1);
  }, () => { throw new Error('network unavailable'); });
});

test('credential rotation cannot bypass the gate or expose the previous account quota', async () => {
  await fixture(async ({ clock, provider }) => {
    await provider.fetchUsage();
    clock.token = 'different-account';
    await assert.rejects(provider.fetchUsage(), /paused until/);
    assert.equal(clock.calls, 1);
    clock.time += CLAUDE_QUOTA_INTERVAL_MS;
    await provider.fetchUsage();
    assert.equal(clock.calls, 2);
  });
});

test('corrupted cooldown state fails closed without contacting the endpoint', async () => {
  await fixture(async ({ clock, provider, stateFile }) => {
    mkdirSync(join(stateFile, '..'), { recursive: true });
    writeFileSync(stateFile, '{"version":1,"nextAllowedAt":"invalid"}');
    await assert.rejects(provider.fetchUsage(), /Invalid Claude quota cooldown/);
    assert.equal(clock.calls, 0);
  });
});

test('patch applies idempotently, restores exactly, and refuses unrelated changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paseo-claude-install-'));
  const t = { ...target, server: dir };
  const stateName = `claude-${sha(dir).slice(0, 20)}.json`;
  const file = join(dir, base, 'claude.js');
  try {
    mkdirSync(join(dir, base), { recursive: true });
    cpSync(join(target.server, base, 'claude.js'), file);
    let original = readFileSync(file, 'utf8');
    if (original.startsWith('// paseo-agy-quote:claude-throttle')) original = unpatchedClaude(original);
    writeFileSync(file, original);
    assert.equal(checkClaude(t).installed, false);
    applyClaude(t, { runTests: false });
    assert.equal(checkClaude(t).installed, true);
    assert.match(applyClaude(t, { runTests: false }), /already applied/);
    const patched = readFileSync(file, 'utf8');
    writeFileSync(file, patched + '\n// unrelated');
    assert.throws(() => rollbackClaude(t), /Incompatible|changed/);
    assert.equal(readFileSync(file, 'utf8'), patched + '\n// unrelated');
    writeFileSync(file, patched);
    rollbackClaude(t);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(existsSync(join(dir, base, 'claude-quota-throttle.js')), false);
    writeFileSync(file, original + '\n// upstream update');
    assert.throws(() => applyClaude(t, { runTests: false }), /Incompatible/);
    assert.throws(() => patchedClaude('unknown layout'), /refuse blind patch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const name of readdirSync(join(ROOT, '.state'))) if (name.startsWith(stateName)) rmSync(join(ROOT, '.state', name));
  }
});
