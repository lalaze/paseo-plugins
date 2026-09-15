import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { backgroundConsumptionRange, projectConsumptionReport } from '../shared/consumption-cache.ts';
import { emptyTokens, presetRange, type ConsumptionRange, type ConsumptionReport } from '../shared/consumption.ts';
import { monthRange } from '../shared/heatmap.ts';
import { ConsumptionService } from '../server/consumption.ts';
import { startConsumptionSync as startServerSync } from '../server/consumption-sync.ts';
import { startConsumptionSync as startClientSync } from '../client/consumption-sync.ts';
import { createConsumptionQuery } from '../client/consumption-query.ts';
import { createHostRegistry } from '../client/hosts.ts';
import { combineHostConsumption, createMultiHostConsumption } from '../client/multi-host-consumption.ts';

const settle = async () => { for (let i = 0; i < 15; i++) await setImmediate(); };
const now = new Date('2026-09-15T12:00:00Z');
const coverage = backgroundConsumptionRange('UTC', now);
const sample = (range = coverage): ConsumptionReport => ({ range, scanning: false, sources: [{ source: 'codex', status: 'ready', updatedAt: now.toISOString(), message: null, rows: [1, 10, 15].map(day => ({ ...emptyTokens(), date: `2026-09-${String(day).padStart(2, '0')}`, model: 'gpt-6-astra', inferredModel: false, input: day * 100 })) }] });

test('one coverage spans all common views through local midnight, month boundaries and leap years', () => {
  assert.deepEqual(coverage, { since: '2026-09-01', until: '2026-09-30', timezone: 'UTC' });
  assert.deepEqual(backgroundConsumptionRange('Asia/Shanghai', new Date('2026-08-31T16:01:00Z')), { since: '2026-08-26', until: '2026-09-30', timezone: 'Asia/Shanghai' });
  assert.equal(backgroundConsumptionRange('UTC', new Date('2024-02-20')).until, '2024-02-29');
  for (const [preset, expected] of [['today', 1500], ['week', 2500], ['month', 2600]] as const) {
    const report = projectConsumptionReport(sample(), presetRange(preset, 'UTC', now));
    assert.equal(report.sources[0].rows.reduce((sum, row) => sum + row.input, 0), expected);
  }
  assert.throws(() => projectConsumptionReport(sample(), { ...coverage, timezone: 'Asia/Shanghai' }), /不匹配/);
  assert.throws(() => projectConsumptionReport(sample(), { ...coverage, since: '2026-08-31' }), /不匹配/);
});

test('daemon continues periodic scans without further RPCs, rechecks Providers and stops on unload', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now });
  let enabled = ['codex'], calls = 0, fail = false;
  const service = new ConsumptionService(async () => { calls++; return { rows: sample().sources[0].rows, message: null }; });
  const api = { providers: { async snapshot() { if (fail) throw new Error('unavailable'); return { entries: enabled.map(provider => ({ provider, enabled: true })) }; } } };
  const sync = startServerSync(service);
  try {
    sync.watch(api as never, 'UTC'); service.get(coverage, ['codex']); await settle();
    assert.equal(calls, 1);
    t.mock.timers.tick(60000); await settle(); assert.equal(calls, 2);
    enabled = []; t.mock.timers.tick(60000); await settle(); assert.equal(calls, 2); assert.deepEqual(service.get(coverage, []).sources, []);
    enabled = ['codex']; t.mock.timers.tick(60000); await settle(); assert.equal(calls, 3);
    fail = true; t.mock.timers.tick(60000); await settle(); assert.equal(calls, 3);
    fail = false; t.mock.timers.tick(60000); await settle(); assert.equal(calls, 4);
    sync.dispose(); t.mock.timers.tick(180000); await settle(); assert.equal(calls, 4);
  } finally { sync.dispose(); service.dispose(); }
});

test('a slow Provider snapshot cannot overlap another tick or launch a scan after cleanup', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let finish!: (value: unknown) => void, reads = 0, calls = 0;
  const service = new ConsumptionService(async () => { reads++; return { rows: [], message: null }; });
  const sync = startServerSync(service, () => now);
  sync.watch({ providers: { snapshot() { calls++; return new Promise(resolve => { finish = resolve; }); } } } as never, 'UTC');
  t.mock.timers.tick(180000); assert.equal(calls, 1);
  sync.dispose(); finish({ entries: [{ provider: 'codex', enabled: true }] }); await settle();
  assert.equal(reads, 0); service.dispose();
});

test('daemon limits warming to two recent client timezones', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const ranges: ConsumptionRange[] = [];
  const sync = startServerSync({ get(range: ConsumptionRange) { ranges.push(range); } } as never, () => now);
  const api = { providers: { async snapshot() { return { entries: [] }; } } };
  try {
    for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York']) sync.watch(api as never, timezone);
    t.mock.timers.tick(60000); await settle();
    assert.deepEqual(ranges.map(range => range.timezone), ['Asia/Shanghai', 'America/New_York']);
  } finally { sync.dispose(); }
});

test('client warms usage without a page, reuses it immediately, rolls months and cleans up', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now });
  const client = new QueryClient(), calls: ConsumptionRange[] = [], registry = createHostRegistry();
  const query = createConsumptionQuery(client, (async (_contract, input: { range: ConsumptionRange }) => { calls.push(input.range); return sample(input.range); }) as never, { subscribe() { return () => {}; } });
  const registration = registry.register({ consumption: query }); registration.identify({ id: 'code', label: 'code' });
  let clock = now;
  const stop = startClientSync(query, 'UTC', () => clock);
  try {
    await settle(); assert.deepEqual(calls, [coverage]);
    const aggregate = createMultiHostConsumption(registry, null); aggregate.mount();
    const observer = new QueryObserver(aggregate.client, aggregate.options(presetRange('today', 'UTC', now)));
    try {
      assert.equal(observer.getCurrentResult().isPending, false);
      assert.equal(observer.getCurrentResult().data?.hosts?.[0].total, 1500);
      for (const range of [presetRange('today', 'UTC', now), presetRange('week', 'UTC', now), presetRange('month', 'UTC', now), monthRange('2026-09', 'UTC')]) await registry.ensure('code', range);
      assert.equal(calls.length, 1, 'opening common views must not issue separate scans');
    } finally { observer.destroy(); aggregate.dispose(); }
    clock = new Date('2026-10-01T00:01:00Z'); t.mock.timers.tick(30000); await settle();
    assert.equal(calls.at(-1)?.since, '2026-09-25'); assert.equal(calls.at(-1)?.until, '2026-10-31');
    stop(); const count = calls.length; t.mock.timers.tick(180000); await settle(); assert.equal(calls.length, count);
  } finally { stop(); registration.dispose(); query.dispose(); client.clear(); }
});

test('background refresh retains ready totals, while a background error remains visible', async () => {
  const client = new QueryClient(), registry = createHostRegistry();
  const query = createConsumptionQuery(client, (async () => { throw new Error('offline'); }) as never, { subscribe() { return () => {}; } });
  const registration = registry.register({ consumption: query }); registration.identify({ id: 'code', label: 'code' });
  try {
    client.setQueryData(['token-consumption', coverage], { ...sample(), scanning: true });
    const report = combineHostConsumption(registry.getSnapshot(), presetRange('today', 'UTC', now));
    assert.equal(report.scanning, true); assert.equal(report.hosts![0].status, 'ready'); assert.equal(report.hosts![0].total, 1500);
    await client.fetchQuery({ ...query.options(coverage), staleTime: 0, retry: false }).catch(() => {});
    const failed = combineHostConsumption(registry.getSnapshot(), presetRange('today', 'UTC', now));
    assert.equal(failed.hosts![0].status, 'error'); assert.equal(failed.hosts![0].total, 1500);
    client.removeQueries({ queryKey: ['token-consumption'] });
    await client.fetchQuery({ ...query.options(coverage), retry: false }).catch(() => {});
    const missing = combineHostConsumption(registry.getSnapshot(), presetRange('today', 'UTC', now));
    assert.equal(missing.hosts![0].status, 'error'); assert.equal(missing.hosts![0].total, null); assert.equal(missing.scanning, false);
  } finally { registration.dispose(); query.dispose(); client.clear(); }
});
