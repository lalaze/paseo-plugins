import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { QueryObserver } from '@tanstack/react-query';
import type { PaseoProviderSnapshotUpdate } from '@getpaseo/client';
import { createConsumptionQuery } from '../client/consumption-query.ts';
import { createUsageQuery } from '../client/query.ts';
import { HostRegistry } from '../client/hosts.ts';
import { combineHostConsumption, createMultiHostConsumption } from '../client/multi-host-consumption.ts';
import { emptyTokens, groupConsumption, totalTokens, type ConsumptionReport, type ConsumptionRange } from '../shared/consumption.ts';
import { buildMonthHeatmap } from '../shared/heatmap.ts';

const range = { since: '2026-09-01', until: '2026-09-15', timezone: 'UTC' };
const other = { ...range, since: '2026-08-01', until: '2026-08-31' };
const sample = (input: number, inputRange = range, provider: 'codex' | 'claude' = 'codex'): ConsumptionReport => ({ range: inputRange, scanning: false, sources: [{ source: provider, status: 'ready', updatedAt: '2026-09-15T12:00:00Z', message: null, rows: [{ ...emptyTokens(), input, output: 10, model: 'gpt-6-astra', date: inputRange.since, inferredModel: false }] }] });
const settle = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };
function fixture(registry: HostRegistry, id: string, rpc = async (_range: ConsumptionRange) => sample(100)) {
  const query = createUsageQuery({ providers: { async listUsage() { return { providers: [], fetchedAt: new Date().toISOString() }; } } } as never);
  let providerUpdate!: (snapshot: PaseoProviderSnapshotUpdate) => void, calls = 0;
  const consumption = createConsumptionQuery(query.client, (async (_contract, input: { range: ConsumptionRange }) => { calls++; return rpc(input.range); }) as never, { subscribe(listener) { providerUpdate = listener; return () => {}; } });
  const runtime = { query, consumption, preference: { get: () => null, subscribe: () => () => {}, save: async () => {}, load: async () => {} } };
  const registration = registry.register(runtime); registration.identify({ id, label: id });
  return { ...runtime, registration, get calls() { return calls; }, providerUpdate: (snapshot: PaseoProviderSnapshotUpdate) => providerUpdate(snapshot),
    seed(report: ConsumptionReport) { query.client.setQueryData(['token-consumption', report.range], report); },
    dispose() { registration.dispose(); consumption.dispose(); query.client.clear(); },
  };
}

test('combined totals preserve host/model identities and match the monthly heatmap', () => {
  const registry = new HostRegistry(), linux = fixture(registry, 'code'), mac = fixture(registry, 'Mac');
  try {
    linux.seed(sample(100)); mac.seed(sample(200));
    const report = combineHostConsumption(registry.getSnapshot(), range), groups = groupConsumption(report.sources, 'source');
    assert.equal(report.scanning, false); assert.equal(groups.length, 1); assert.equal(totalTokens(groups[0]), 320); assert.equal(groups[0].models.length, 2);
    assert.deepEqual(groups[0].models.map(model => model.host?.id).sort(), ['Mac', 'code']);
    const heatmap = buildMonthHeatmap(report.sources, '2026-09', range.until);
    assert.equal(heatmap.total, 320); assert.equal(heatmap.models.length, 2); assert.notEqual(heatmap.models[0].key, heatmap.models[1].key);
    assert.equal(buildMonthHeatmap(report.sources, '2026-09', range.until, heatmap.models[0].key).total, totalTokens(heatmap.models[0]));
    linux.registration.identify({ id: 'code', label: '相同名称' }, true); mac.registration.identify({ id: 'Mac', label: '相同名称' }, true);
    assert.equal(groupConsumption(combineHostConsumption(registry.getSnapshot(), range).sources, 'host').length, 2);
  } finally { linux.dispose(); mac.dispose(); }
});

test('slow hosts do not block fast results; subsequent reads reuse each host cache', async () => {
  const registry = new HostRegistry(); let finish!: (report: ConsumptionReport) => void;
  const linux = fixture(registry, 'code'), mac = fixture(registry, 'Mac', () => new Promise(resolve => { finish = resolve; }));
  const query = createMultiHostConsumption(registry, null); query.mount();
  try {
    await query.client.fetchQuery(query.options(range)); await settle();
    let report = query.client.getQueryData<ConsumptionReport>(['token-consumption', range])!;
    assert.equal(report.scanning, true); assert.deepEqual(report.sources.map(source => source.host?.id), ['code']);
    assert.equal(report.hosts!.find(host => host.id === 'Mac')?.total, null);
    finish(sample(200)); await settle(); report = query.client.getQueryData<ConsumptionReport>(['token-consumption', range])!;
    assert.equal(report.scanning, false); assert.equal(report.hosts!.reduce((sum, host) => sum + (host.total ?? 0), 0), 320);
    await registry.ensure('code', range); await registry.ensure('Mac', range); assert.equal(linux.calls, 1); assert.equal(mac.calls, 1);
  } finally { finish?.(sample(200)); query.dispose(); linux.dispose(); mac.dispose(); }
});

test('disconnection retains only matching cached ranges and ignores late refreshes', async () => {
  const registry = new HostRegistry(); let finish!: (report: ConsumptionReport) => void;
  const mac = fixture(registry, 'Mac', () => new Promise(resolve => { finish = resolve; })); mac.seed(sample(200));
  const pending = registry.ensure('Mac', range, true); await settle(); mac.dispose(); finish(sample(999)); await pending;
  const report = combineHostConsumption(registry.getSnapshot(), range);
  assert.equal(report.scanning, false); assert.equal(report.hosts![0].status, 'offline'); assert.equal(report.hosts![0].total, 210);
  const missing = combineHostConsumption(registry.getSnapshot(), other); assert.equal(missing.hosts![0].total, null); assert.deepEqual(missing.sources, []);
});

test('Provider changes prune every cached range on one host without hiding another host', async () => {
  const registry = new HostRegistry(), linux = fixture(registry, 'code'), mac = fixture(registry, 'Mac');
  try {
    for (const dateRange of [range, other]) { linux.seed(sample(100, dateRange, 'claude')); mac.seed(sample(200, dateRange, 'claude')); }
    linux.providerUpdate({ entries: [{ provider: 'claude', enabled: false, status: 'ready' }], generatedAt: '2026-09-15T12:00:00Z' }); await settle();
    for (const dateRange of [range, other]) {
      const report = combineHostConsumption(registry.getSnapshot(), dateRange); assert.deepEqual(report.sources.map(source => source.host?.id), ['Mac']);
      assert.equal(report.hosts!.find(host => host.id === 'code')?.total, 0);
    }
  } finally { linux.dispose(); mac.dispose(); }
});

test('newly loaded hosts join an open aggregate without waiting for its polling interval', async () => {
  const registry = new HostRegistry(), linux = fixture(registry, 'code'), query = createMultiHostConsumption(registry, null); query.mount();
  const observer = new QueryObserver(query.client, query.options(range)), unsubscribe = observer.subscribe(() => {}); let mac: ReturnType<typeof fixture> | undefined;
  try {
    await settle(); mac = fixture(registry, 'Mac', async () => sample(200)); await settle();
    assert.equal(mac.calls, 1); assert.equal(observer.getCurrentResult().data?.hosts?.length, 2);
    assert.equal(observer.getCurrentResult().data?.hosts?.reduce((sum, host) => sum + (host.total ?? 0), 0), 320);
  } finally { unsubscribe(); observer.destroy(); query.dispose(); linux.dispose(); mac?.dispose(); }
});

test('same daemon registers once; old cleanup cannot disconnect or rename its replacement', () => {
  const registry = new HostRegistry(), old = fixture(registry, 'Mac'); old.seed(sample(100)); const current = fixture(registry, 'Mac');
  try {
    current.registration.identify({ id: 'Mac', label: '用户命名的 Mac' }, true); current.registration.identify({ id: 'Mac', label: 'machine.local' });
    old.dispose(); current.seed(sample(300)); assert.equal(registry.getSnapshot().length, 1); assert.equal(registry.getSnapshot()[0].online, true);
    assert.equal(registry.getSnapshot()[0].label, '用户命名的 Mac'); assert.equal(combineHostConsumption(registry.getSnapshot(), range).hosts![0].total, 310);
  } finally { current.dispose(); }
});

test('quota snapshots remain separate and survive disconnection without adding percentages', () => {
  const registry = new HostRegistry(), linux = fixture(registry, 'code'), mac = fixture(registry, 'Mac');
  const quota = (remainingPct: number) => ({ fetchedAt: '2026-09-15T12:00:00Z', providers: [{ providerId: 'codex', status: 'available', displayName: 'Codex', windows: [{ id: 'week', label: 'Week', remainingPct }] }] });
  linux.query.client.setQueryData(linux.query.options.queryKey, quota(40)); mac.query.client.setQueryData(mac.query.options.queryKey, quota(70)); mac.dispose();
  try { assert.deepEqual(registry.getSnapshot().map(host => host.quota!.providers[0].windows[0].remainingPct).sort(), [40, 70]); assert.equal(registry.get('Mac')?.online, false); }
  finally { linux.dispose(); }
});

test('discarded local caches cannot leave disabled source data in the shared registry', () => {
  const registry = new HostRegistry(), linux = fixture(registry, 'code');
  try { linux.seed(sample(100)); linux.query.client.removeQueries({ queryKey: ['token-consumption'] }); assert.equal(registry.get('code')!.reports.size, 0); }
  finally { linux.dispose(); }
});

test('an initial scan or failed host stays unknown until a source returns a reading', () => {
  const registry = new HostRegistry(), mac = fixture(registry, 'Mac');
  try {
    const initial = sample(0); initial.scanning = true; initial.sources[0] = { ...initial.sources[0], status: 'loading', updatedAt: null, rows: [] };
    mac.seed(initial);
    let report = combineHostConsumption(registry.getSnapshot(), range);
    assert.equal(report.hosts![0].total, null); assert.equal(report.scanning, true);
    registry.get('Mac')!.errors.set(JSON.stringify([range.since, range.until, range.timezone]), Date.now());
    report = combineHostConsumption(registry.getSnapshot(), range);
    assert.equal(report.hosts![0].status, 'error'); assert.equal(report.scanning, false); assert.equal(report.hosts![0].total, null);
    mac.seed({ ...initial, scanning: false, sources: [{ ...initial.sources[0], status: 'empty' }] });
    assert.equal(combineHostConsumption(registry.getSnapshot(), range).hosts![0].total, 0);
  } finally { mac.dispose(); }
});

test('a successful retry clears the host error even when consumption has not changed', async () => {
  const registry = new HostRegistry(); let fails = true;
  const mac = fixture(registry, 'Mac', async () => { if (fails) throw new Error('offline'); return sample(100); });
  try {
    mac.seed(sample(100)); await registry.ensure('Mac', range, true);
    assert.equal(combineHostConsumption(registry.getSnapshot(), range).hosts![0].status, 'error');
    fails = false; await registry.ensure('Mac', range, true);
    const report = combineHostConsumption(registry.getSnapshot(), range);
    assert.equal(report.hosts![0].status, 'ready'); assert.equal(report.hosts![0].total, 110);
  } finally { mac.dispose(); }
});
