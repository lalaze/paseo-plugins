import assert from 'node:assert/strict';
import test from 'node:test';
import { agyCandidates, quotaWindows, readOfficialQuota, supportsUsagePrint } from '../server/antigravity-quota.ts';
import { registerAntigravityUsage } from '../server/antigravity-usage.ts';

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

test('the usage source registers provider id antigravity and hides a failed read', async () => {
  const calls: string[][] = [];
  const run = async (_file: string, args: string[]) => {
    calls.push(args);
    if (args[0] === '--version') return '1.3.1';
    return JSON.stringify(envelope);
  };
  let registered: { id: string; label: string; discover: (scope: { kind: string }) => Promise<unknown>; fetch: () => Promise<{ status: string; windows?: { remainingPct: number; resetsAt: string | null }[] }> } | undefined;
  registerAntigravityUsage({
    registerUsageSource(source) { registered = source as typeof registered; },
  }, { resolve: async () => '/official/agy', run });
  assert.equal(registered?.id, 'antigravity');
  assert.equal(registered?.label, 'Antigravity');
  assert.deepEqual(await registered?.discover({ kind: 'global' }), [{ key: 'default', input: {} }]);
  assert.deepEqual(await registered?.discover({ kind: 'session' }), []);
  const report = await registered!.fetch();
  assert.equal(report.status, 'available');
  assert.equal(report.windows?.[0]?.remainingPct, 80);
  assert.equal(report.windows?.[0]?.resetsAt, '2026-10-15T07:43:08.000Z');
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
