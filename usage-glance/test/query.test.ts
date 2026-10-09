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
  assert.equal(await fallback.client.fetchQuery(fallback.options), missing);
  fallback.client.clear();
});
