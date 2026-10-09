import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { agyCandidates, quotaWindows, readOfficialQuota, supportsUsagePrint } from '../server/antigravity-quota.ts';
import { registerAntigravityQuota } from '../server/antigravity-usage.ts';
import { readAntigravityQuota, type AntigravityQuotaSnapshot } from '../shared/antigravity-quota.ts';

const envelope = {
  status: 'SUCCESS',
  num_turns: 0,
  usage: { total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.8, reset_time: '2026-10-15T07:43:08Z' },
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.5, reset_time: '2026-10-08T12:43:08Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-10-15T09:44:17Z' },
            { id: '3p-5h', window: '5h', remaining_fraction: 0, reset_time: 'not-a-date' },
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.1, reset_time: '2026-10-15T07:43:08Z' },
          ],
        },
      ],
    },
  },
};

test('official usage JSON becomes remaining windows and reset times', () => {
  const windows = quotaWindows(envelope);
  assert.deepEqual(windows.map(window => [window.id, window.label, window.remainingPct, window.resetsAt]), [
    ['gemini-weekly', 'Gemini Models · Weekly limit', 80, '2026-10-15T07:43:08.000Z'],
    ['gemini-5h', 'Gemini Models · 5-hour limit', 50, '2026-10-08T12:43:08.000Z'],
    ['3p-weekly', 'Claude and GPT models · Weekly limit', 100, '2026-10-15T09:44:17.000Z'],
    ['3p-5h', 'Claude and GPT models · 5-hour limit', 0, null],
  ]);
  assert.equal(quotaWindows({ command: { name: 'usage', data: { groups: [] } }, num_turns: 1 }).length, 0);
  assert.equal(quotaWindows({ status: 'SUCCESS', response: 'Gemini Models\t99%' }).length, 0);
  assert.equal(quotaWindows({ command: { name: 'prompt', data: { groups: envelope.command.data.groups } } }).length, 0);
});

test('usage print is refused before the CLI learned the command', () => {
  assert.equal(supportsUsagePrint('1.1.10'), false);
  assert.equal(supportsUsagePrint('1.0.9'), false);
  assert.equal(supportsUsagePrint('1.1.11'), true);
  assert.equal(supportsUsagePrint('1.3.1\n'), true);
  assert.equal(supportsUsagePrint('agy'), false);
});

test('official binary lookup ignores the retired hub and bridge paths', () => {
  const candidates = agyCandidates({
    PASEO_ANTIGRAVITY_BIN: '/official/agy',
    AGY_HUB_BIN: '/retired/hub/agy',
    PATH: '/usr/bin:/opt/bin',
  }, '/Users/example');
  assert.equal(candidates[0], '/official/agy');
  assert.deepEqual(candidates.slice(1, 3), ['/usr/bin/agy', '/opt/bin/agy']);
  assert.equal(candidates.includes('/retired/hub/agy'), false);
});

test('quota RPC works alongside the built-in source, shares reads and caches real timestamps', async () => {
  let now = Date.parse('2026-10-08T16:00:00Z');
  const calls: string[][] = [];
  const run = async (_file: string, args: string[], timeoutMs: number) => {
    calls.push(args);
    if (args[0] === '--version') return '1.3.1';
    assert.equal(timeoutMs, 60000);
    return JSON.stringify(envelope);
  };
  let fetch!: () => Promise<AntigravityQuotaSnapshot>;
  registerAntigravityQuota({
    registerUsageSource() { throw new Error('Duplicate usage source: antigravity'); },
    handle(contract, handler) {
      assert.equal(contract, readAntigravityQuota);
      fetch = () => handler({}, {}) as Promise<AntigravityQuotaSnapshot>;
    },
  }, { resolve: async () => '/official/agy', run }, () => now);
  const [initial, concurrent] = await Promise.all([fetch(), fetch()]);
  assert.equal(initial.refreshing, true);
  assert.deepEqual(concurrent, initial);
  await setImmediate();
  const report = await fetch();
  assert.equal(calls.length, 2);
  assert.equal(report.windows[0]?.remainingPct, 80);
  assert.equal(report.windows[0]?.resetsAt, '2026-10-15T07:43:08.000Z');
  now += 60000;
  assert.deepEqual(await fetch(), report);
  assert.equal(calls.length, 2);
  now += 240000;
  assert.equal((await fetch()).refreshing, true);
  await setImmediate();
  assert.notEqual((await fetch()).fetchedAt, report.fetchedAt);
  assert.equal(calls.length, 4);
  const old = await readOfficialQuota({
    resolve: async () => '/official/agy',
    run: async (_file, args) => {
      assert.deepEqual(args, ['--version']);
      return '1.1.10';
    },
  });
  assert.equal(old, null);
  assert.ok(calls.some(args => args[0] === '-p' && args[1] === '/usage'));
});

test('failed quota reads are empty and retry after one minute', async () => {
  let now = 0, calls = 0;
  let fetch!: () => Promise<AntigravityQuotaSnapshot>;
  registerAntigravityQuota({ handle(_contract, handler) { fetch = () => handler({}, {}) as Promise<AntigravityQuotaSnapshot>; } }, {
    resolve: async () => { calls++; return null; },
  }, () => now);
  assert.deepEqual((await fetch()).windows, []);
  await setImmediate();
  now = 59999;
  await fetch();
  assert.equal(calls, 1);
  now = 60000;
  await fetch();
  await setImmediate();
  assert.equal(calls, 2);
});

test('cache expiry followed by a failed CLI read retains the last successful quota', async () => {
  let now = 0, fail = false;
  let fetch!: () => Promise<AntigravityQuotaSnapshot>;
  registerAntigravityQuota({ handle(_contract, handler) { fetch = () => handler({}, {}) as Promise<AntigravityQuotaSnapshot>; } }, {
    resolve: async () => '/official/agy',
    run: async (_file, args) => args[0] === '--version' ? '1.3.1' : fail ? null : JSON.stringify(envelope),
  }, () => now);
  await fetch(); await setImmediate();
  const first = await fetch();
  now = 300000; fail = true;
  const updating = await fetch();
  assert.equal(updating.refreshing, true);
  assert.deepEqual(updating.windows, first.windows);
  await setImmediate();
  const failed = await fetch();
  assert.deepEqual(failed.windows, first.windows);
  assert.equal(failed.fetchedAt, first.fetchedAt);
  assert.equal(failed.stale, true);
  now += 60000; fail = false;
  await fetch(); await setImmediate();
  const recovered = await fetch();
  assert.equal(recovered.stale, false);
  assert.notEqual(recovered.fetchedAt, first.fetchedAt);
});

test('a slow CLI cannot block quota RPCs or start overlapping reads', async () => {
  let release!: (value: string | null) => void, reads = 0;
  let fetch!: () => Promise<AntigravityQuotaSnapshot>;
  registerAntigravityQuota({ handle(_contract, handler) { fetch = () => handler({}, {}) as Promise<AntigravityQuotaSnapshot>; } }, {
    resolve: async () => '/official/agy',
    run: async (_file, args) => {
      if (args[0] === '--version') return '1.3.1';
      reads++;
      return new Promise(resolve => { release = resolve; });
    },
  });
  assert.equal((await fetch()).refreshing, true);
  await setImmediate();
  assert.equal((await fetch()).refreshing, true);
  assert.equal(reads, 1);
  release(JSON.stringify(envelope)); await setImmediate();
  assert.equal((await fetch()).refreshing, false);
  assert.equal((await fetch()).windows.length, 4);
});
