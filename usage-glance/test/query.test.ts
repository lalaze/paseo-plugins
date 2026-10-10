import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageQuery } from '../client/query.ts';
import type { PaseoApi } from '@getpaseo/client';
import type { UsageResult } from '../shared/usage.ts';

const native = (available = false): UsageResult => ({
  requestId: 'native', fetchedAt: '2026-10-08T16:00:00.000Z', providers: [
    { providerId: 'codex', displayName: 'Codex', status: 'available', planLabel: null, windows: [{ id: 'session', label: 'Session', remainingPct: 76 }] },
    { providerId: 'antigravity', displayName: 'Google Antigravity', status: available ? 'available' : 'unavailable', planLabel: null, windows: available ? [{ id: 'native', label: 'Quota', remainingPct: 80 }] : [] },
  ],
});
const snapshot = { fetchedAt: '2026-10-08T15:59:00.000Z', windows: [{ id: 'weekly', label: 'Gemini Models · Weekly limit', remainingPct: 99.96, usedPct: 0.04, resetsAt: null, tone: 'ok' as const }] };
const api = (result: UsageResult) => ({ providers: { listUsage: async () => result } }) as unknown as PaseoApi;

test('account switches replace the current provider quota instead of adding a stale session account', async () => {
  const account = (email: string, remainingPct: number) => ({
    ...native().providers[0], displayName: `Codex (${email})`,
    windows: [{ id: 'weekly', label: 'Weekly', remainingPct }],
  });
  const old = account('old@example.com', 8);
  const current = account('current@example.com', 99);
  const next = account('next@example.com', 54);
  const kimi = { ...old, providerId: 'kimi', displayName: 'Kimi' };
  let result: UsageResult = { ...native(), providers: [old, kimi] };
  const query = createUsageQuery({ providers: { listUsage: async () => result } } as unknown as PaseoApi);
  try {
    assert.deepEqual((await query.client.fetchQuery(query.options)).providers, [old, kimi]);
    result = { ...result, providers: [current, kimi, old] };
    assert.deepEqual((await query.client.fetchQuery({ ...query.options, staleTime: 0 })).providers, [current, kimi]);
    result = { ...result, providers: [next, kimi, old, current] };
    assert.deepEqual((await query.client.fetchQuery({ ...query.options, staleTime: 0 })).providers, [next, kimi]);
    assert.deepEqual(result.providers, [next, kimi, old, current], 'the daemon response remains unchanged');
  } finally { query.client.clear(); }
});

test('stale session accounts are removed on native and fallback quota paths without replacing an unavailable current account', async () => {
  for (const available of [false, true]) {
    const result = native(available);
    const current = { ...result.providers[0], displayName: 'Codex (current@example.com)', status: 'unavailable' as const, windows: [] };
    const old = { ...result.providers[0], displayName: 'Codex (old@example.com)' };
    result.providers = [current, result.providers[1], old];
    let calls = 0;
    const query = createUsageQuery(api(result), async () => { calls++; return snapshot; });
    try {
      const filled = await query.client.fetchQuery(query.options);
      assert.deepEqual(filled.providers.filter(provider => provider.providerId === 'codex'), [current]);
      assert.equal(filled.providers.length, 2);
      assert.equal(filled.providers[1]?.windows[0]?.remainingPct, available ? 80 : 99.96);
      assert.equal(calls, available ? 0 : 1);
      assert.equal(result.providers.length, 3);
    } finally { query.client.clear(); }
  }
});

test('missing native Antigravity quota is filled from the official CLI without duplicating providers', async () => {
  const result = native();
  let calls = 0;
  const query = createUsageQuery(api(result), async () => { calls++; return snapshot; });
  const filled = await query.client.fetchQuery(query.options);
  assert.equal(calls, 1);
  assert.equal(filled.providers.filter(provider => provider.providerId === 'antigravity').length, 1);
  assert.equal(filled.providers[1]?.windows[0]?.remainingPct, 99.96);
  assert.equal(filled.providers[0], result.providers[0]);
  assert.equal(filled.fetchedAt, snapshot.fetchedAt);
  assert.equal(result.providers[1]?.status, 'unavailable');
  query.client.clear();
});

test('valid native quota is preferred and fallback failure preserves other quotas', async () => {
  const result = native(true);
  const query = createUsageQuery(api(result), async () => { throw new Error('must not query agy'); });
  assert.equal(await query.client.fetchQuery(query.options), result);
  query.client.clear();
  const missing = native();
  const fallback = createUsageQuery(api(missing), async () => { throw new Error('CLI unavailable'); });
  const failed = await fallback.client.fetchQuery(fallback.options);
  assert.equal(failed.providers[0], missing.providers[0]);
  assert.equal(failed.providers[1]?.status, 'unavailable');
  assert.equal(failed.providers[1]?.quotaStale, true);
  fallback.client.clear();
});

test('an initial background read polls quickly and a stale snapshot is marked as previous data', async () => {
  let response = { ...snapshot, windows: [], stale: true, refreshing: true };
  const query = createUsageQuery(api(native()), async () => response);
  const pending = await query.client.fetchQuery(query.options);
  assert.equal(pending.providers[1]?.quotaRefreshing, true);
  assert.equal(pending.providers[1]?.quotaStale, true);
  assert.equal(typeof query.options.refetchInterval === 'function'
    ? query.options.refetchInterval(query.client.getQueryCache().find({ queryKey: query.options.queryKey })!) : 0, 1500);
  response = { ...snapshot, stale: false, refreshing: false };
  const ready = await query.client.fetchQuery({ ...query.options, staleTime: 0 });
  assert.equal(ready.providers[1]?.windows[0]?.remainingPct, 99.96);
  assert.equal(ready.providers[1]?.quotaStale, false);
  response = { ...snapshot, stale: true, refreshing: false };
  const stale = await query.client.fetchQuery({ ...query.options, staleTime: 0 });
  assert.equal(stale.providers[1]?.quotaStale, true);
  assert.equal(stale.fetchedAt, snapshot.fetchedAt);
  query.client.clear();
});

test('an unsuccessful refresh retains the last native quota with its original timestamp', async () => {
  let result = native(true);
  const query = createUsageQuery({ providers: { listUsage: async () => result } } as unknown as PaseoApi,
    async () => ({ ...snapshot, windows: [] }));
  const first = await query.client.fetchQuery(query.options);
  result = { ...native(), fetchedAt: '2026-10-08T16:10:00.000Z' };
  const failed = await query.client.fetchQuery({ ...query.options, staleTime: 0 });
  assert.equal(failed.providers[1]?.windows[0]?.remainingPct, 80);
  assert.equal(failed.fetchedAt, first.fetchedAt);
  assert.ok(failed.providers[1]?.details?.some(detail => /previous|cached/i.test(detail.value)));
  assert.equal(failed.providers[0], result.providers[0]);
  query.client.clear();
});

test('RPC failure after a successful fallback keeps quota until a fresh reading recovers', async () => {
  let fail = false;
  const query = createUsageQuery(api(native()), async () => {
    if (fail) throw new Error('RPC timeout');
    return snapshot;
  });
  await query.client.fetchQuery(query.options);
  fail = true;
  const failed = await query.client.fetchQuery({ ...query.options, staleTime: 0 });
  assert.equal(failed.providers[1]?.windows[0]?.remainingPct, 99.96);
  assert.equal(failed.fetchedAt, snapshot.fetchedAt);
  fail = false;
  const recovered = await query.client.fetchQuery({ ...query.options, staleTime: 0 });
  assert.equal(recovered.providers[1]?.details?.length, 0);
  query.client.clear();
});
