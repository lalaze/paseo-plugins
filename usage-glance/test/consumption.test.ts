import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { emptyTokens, sourceIds, enabledConsumptionSources, unsupportedConsumptionProviders, groupConsumption, modelVendor, presetRange, rangeSchema, totalTokens, type ConsumptionRow, type SourceReport } from '../shared/consumption.ts';
import { parseCcusage } from '../server/ccusage.ts';
import { ConsumptionService } from '../server/consumption.ts';

const range = { since: '2026-09-01', until: '2026-09-15', timezone: 'UTC' };
const rawTokens = { inputTokens: 100, outputTokens: 30, cacheReadTokens: 70, cacheCreationTokens: 20 };
const row: ConsumptionRow = { date: '2026-09-10', model: 'gpt-5.6-sol', inferredModel: false, input: 190, output: 30, cacheRead: 70, cacheWrite: 20, reasoning: null };
const source = (patch: Partial<SourceReport> = {}): SourceReport => ({ source: 'codex', status: 'ready', updatedAt: '2026-09-15T10:00:00Z', rows: [row], message: null, ...patch });

test('dates reject invalid calendar days and excessive ranges; presets respect timezone and DST', () => {
  assert.equal(rangeSchema.safeParse({ ...range, until: '2026-02-30' }).success, false);
  assert.equal(rangeSchema.safeParse({ ...range, since: '2026-09-16' }).success, false);
  assert.equal(rangeSchema.safeParse({ ...range, since: '2024-01-01' }).success, false);
  assert.equal(rangeSchema.safeParse({ ...range, timezone: '--help' }).success, false);
  assert.equal(presetRange('today', 'Asia/Shanghai', new Date('2026-09-14T20:00:00Z')).since, '2026-09-15');
  assert.equal(presetRange('week', 'America/New_York', new Date('2026-03-09T02:00:00Z')).since, '2026-03-02');
  assert.equal(presetRange('month', 'UTC', new Date('2026-09-15')).since, '2026-09-01');
});

test('ccusage cache buckets are normalized once, reasoning is a subset and daily totals are not added again', () => {
  const report = { daily: [{ date: row.date, ...rawTokens, totalTokens: 220, models: { [row.model]: { ...rawTokens, totalTokens: 220, reasoningOutputTokens: 10, isFallback: true } } }], totals: { ...rawTokens, totalTokens: 220 } };
  const rows = parseCcusage(report, range);
  assert.deepEqual(rows, [{ ...row, reasoning: 10, inferredModel: true }]);
  assert.equal(totalTokens(rows[0]), 220);
  const normal = { daily: [{ date: row.date, ...rawTokens, modelBreakdowns: [{ modelName: row.model, ...rawTokens }] }] };
  assert.deepEqual(parseCcusage(normal, range), [row]);
  assert.deepEqual(parseCcusage({ daily: [] }, range), []);
});

test('malformed or inconsistent usage fails visibly instead of silently becoming zero', () => {
  assert.throws(() => parseCcusage({}, range));
  assert.throws(() => parseCcusage({ daily: [{ date: row.date, ...rawTokens, models: { test: { ...rawTokens, outputTokens: 31 } } }] }, range), /不一致/);
  assert.throws(() => parseCcusage({ daily: [{ date: row.date, ...rawTokens, outputTokens: -1 }] }, range));
  assert.throws(() => parseCcusage({ daily: [{ date: row.date, ...rawTokens, totalTokens: 290 }] }, range));
  const rows = parseCcusage({ daily: [{ date: row.date, ...rawTokens }] }, range);
  assert.equal(rows[0].model, '未记录模型');
  assert.equal(rows[0].input, 190);
});

test('supplier grouping follows model, keeping CLI origins and unknown models visible', () => {
  const sources = [source(), source({ source: 'claude', rows: [{ ...row, model: 'glm-5.3-flash-free' }] }), source({ source: 'antigravity', rows: [{ ...row, model: 'Claude Sonnet 4.6' }, { ...row, model: 'gemini-3.8-flash' }] })];
  assert.deepEqual(groupConsumption(sources, 'vendor').map(value => value.label).sort(), ['Anthropic', 'Google', 'OpenAI', '智谱'].sort());
  assert.equal(groupConsumption(sources, 'source').length, 3);
  assert.equal(groupConsumption(sources, 'vendor').find(value => value.label === '智谱')?.models[0].source, 'claude');
  assert.equal(modelVendor('opaque-model', 'claude'), '未识别供应商');
  assert.equal(modelVendor('k3-256k', 'kimi'), '月之暗面');
  assert.equal(modelVendor('grok-4.6-build', 'grok'), 'xAI');
});

test('model grouping combines exact names across days, Providers and hosts without double-counting token subsets', () => {
  const code = { id: 'code', label: 'code' }, mac = { id: 'mac', label: 'Mac' };
  const sources = [
    source({ host: code, rows: [row, { ...row, date: '2026-09-11', inferredModel: true }] }),
    source({ host: mac }),
    source({ source: 'antigravity', host: mac, rows: [row, { ...row, model: 'gpt-5.6-sol-fast' }, { ...row, model: '未记录模型', inferredModel: true }] }),
  ];
  const original = structuredClone(sources), groups = groupConsumption(sources, 'model');
  assert.deepEqual(groups.map(group => [group.label, totalTokens(group)]), [['gpt-5.6-sol', 880], ['gpt-5.6-sol-fast', 220], ['未记录模型', 220]]);
  const merged = groups[0];
  assert.deepEqual(merged.models.map(model => [model.host?.id, model.source, totalTokens(model), model.inferredModel]), [['code', 'codex', 440, true], ['mac', 'codex', 220, false], ['mac', 'antigravity', 220, false]]);
  assert.equal(merged.cacheRead, 280); assert.equal(merged.cacheWrite, 80); assert.equal(merged.reasoning, null);
  for (const by of ['source', 'vendor', 'host', 'model'] as const) assert.equal(groupConsumption(sources, by).reduce((sum, group) => sum + totalTokens(group), 0), 1320);
  assert.equal(groupConsumption(sources.filter(source => source.host?.id === 'mac'), 'model')[0].input, 380);
  assert.deepEqual(groupConsumption([], 'model'), []);
  assert.deepEqual(sources, original);
});

test('consumption follows Provider enabled switches, independent of readiness, and folds Antigravity aliases once', () => {
  assert.deepEqual(enabledConsumptionSources([
    { provider: 'claude', enabled: false, status: 'ready' },
    { provider: 'codex', enabled: true, status: 'unavailable' },
    { provider: 'grok', enabled: true, status: 'loading' },
    { provider: 'kimi', enabled: false, status: 'ready' },
    { provider: 'antigravity-acp', enabled: false, status: 'unavailable' },
    { provider: 'antigravity-hub', enabled: true, status: 'ready' },
    { provider: 'pi', enabled: true, status: 'ready' },
  ]), ['codex', 'grok', 'antigravity', 'pi']);
  assert.deepEqual(enabledConsumptionSources([{ provider: 'antigravity-acp', enabled: true }, { provider: 'antigravity-hub', enabled: true }]), ['antigravity']);
  assert.deepEqual(enabledConsumptionSources([{ provider: 'claude', enabled: false }]), []);
  assert.deepEqual(unsupportedConsumptionProviders([{ provider: 'pi', label: 'Pi', enabled: true }, { provider: 'copilot', label: 'Copilot', enabled: true }, { provider: 'claude', enabled: false }]), [{ id: 'copilot', label: 'Copilot' }]);
});

test('disabled sources are never scanned or returned, including after cached results and enable/disable changes', async () => {
  const calls: string[] = [];
  const service = new ConsumptionService(async source => { calls.push(source); return { rows: [row], message: null }; });
  const settle = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
  try {
    service.get(range, ['codex', 'claude']); await settle();
    assert.equal(service.get(range, ['codex', 'claude']).sources.length, 2);
    calls.length = 0;
    const disabled = service.get(range, ['codex']);
    assert.deepEqual(disabled.sources.map(source => source.source), ['codex']);
    await settle();
    assert.deepEqual(calls, ['codex']);
    assert.equal(groupConsumption(service.get(range, ['codex']).sources, 'source').length, 1);
    const empty = service.get(range, []); await settle();
    assert.equal(empty.scanning, false); assert.deepEqual(empty.sources, []);
    assert.deepEqual(calls, ['codex']);
    const reenabled = service.get(range, ['claude']);
    assert.equal(reenabled.sources[0].status, 'loading'); assert.deepEqual(reenabled.sources[0].rows, []);
    await settle(); assert.deepEqual(calls, ['codex', 'claude']);
  } finally { service.dispose(); }
});

test('a disabled source finishing late cannot restore a previous selection', async () => {
  let finish!: () => void, signal!: AbortSignal;
  const service = new ConsumptionService(async (_source, _range, current) => { signal = current; await new Promise<void>(resolve => { finish = resolve; }); return { rows: [row], message: null }; });
  service.get(range, ['claude']); await setImmediate();
  assert.deepEqual(service.get(range, []).sources, []);
  assert.equal(signal.aborted, true);
  finish(); for (let i = 0; i < 10; i++) await setImmediate();
  assert.deepEqual(service.get(range, []).sources, []); service.dispose();
});

test('scans are nonblocking, bounded, single-flight, replace totals, and retain good data on errors', async () => {
  let clock = 100000, active = 0, maximum = 0, calls = 0, fail = false;
  const service = new ConsumptionService(async source => {
    active++; maximum = Math.max(maximum, active); calls++;
    await setImmediate(); active--;
    if (fail && source === 'codex') throw new Error('本机读取失败');
    return { rows: source === 'codex' ? [row] : [], message: null };
  }, () => clock);
  const first = service.get(range, sourceIds);
  assert.equal(first.scanning, true);
  assert.equal(first.sources.length, sourceIds.length);
  const wait = async () => { for (let i = 0; i < 50 && service.get(range, sourceIds).scanning; i++) await setImmediate(); return service.get(range, sourceIds); };
  const complete = await wait();
  assert.equal(complete.scanning, false);
  assert.equal(calls, sourceIds.length); assert.equal(maximum, 2);
  assert.equal(complete.sources[0].rows.length, 1);
  assert.equal(complete.sources[1].status, 'empty');
  const oldTime = complete.sources[0].updatedAt;
  for (let i = 0; i < 5; i++) service.get(range, sourceIds, true);
  assert.equal(calls, sourceIds.length);
  clock += 61000; service.get(range, sourceIds); await wait();
  assert.equal(service.get(range, sourceIds).sources[0].rows.length, 1);
  assert.equal(calls, sourceIds.length * 2);
  fail = true; clock += 61000; service.get(range, sourceIds); const failed = await wait();
  assert.equal(failed.sources[0].status, 'error');
  assert.equal(failed.sources[0].rows[0].input, 190);
  assert.notEqual(failed.sources[0].updatedAt, oldTime);
  assert.equal(failed.sources[1].status, 'empty');
  service.dispose(); assert.throws(() => service.get(range, sourceIds), /关闭/);
});

test('covering caches are filtered to the exact dates and never reused across timezones', async () => {
  const service = new ConsumptionService(async (_source, input) => ({ rows: input.since === range.since ? [row] : [], message: null }));
  service.get(range, sourceIds); for (let i = 0; i < 10; i++) await setImmediate();
  const other = service.get({ ...range, since: '2026-09-15' }, sourceIds);
  assert.equal(other.scanning, false); assert.ok(other.sources.every(source => source.rows.length === 0 && source.status === 'empty'));
  assert.equal(other.range.since, '2026-09-15');
  const differentZone = service.get({ ...range, timezone: 'Asia/Shanghai' }, sourceIds);
  assert.equal(differentZone.scanning, true); assert.ok(differentZone.sources.every(source => source.rows.length === 0));
  service.dispose(); for (let i = 0; i < 10; i++) await setImmediate();
});
