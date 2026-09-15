import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { QueryClient } from '@tanstack/react-query';
import type { PaseoProviderSnapshotUpdate } from '@getpaseo/client';
import { createConsumptionQuery } from '../client/consumption-query.ts';
import { emptyTokens, type ConsumptionReport } from '../shared/consumption.ts';

const range = { since: '2026-09-01', until: '2026-09-15', timezone: 'UTC' };
const report: ConsumptionReport = { range, scanning: false, sources: ['codex', 'claude'].map(source => ({ source: source as 'codex' | 'claude', status: 'ready', updatedAt: '2026-09-15T10:00:00Z', message: null, rows: [{ ...emptyTokens(), date: '2026-09-10', model: source, input: 100, inferredModel: false }] })) };

test('Provider updates immediately remove disabled data across ranges and reject late manual refresh results', async () => {
  const client = new QueryClient(); let listener!: (value: PaseoProviderSnapshotUpdate) => void, finish!: (value: ConsumptionReport) => void, unsubscribed = false;
  const query = createConsumptionQuery(client, (() => new Promise<ConsumptionReport>(resolve => { finish = resolve; })) as never, { subscribe(callback) { listener = callback; return () => { unsubscribed = true; }; } });
  const other = { ...range, since: '2026-09-15' };
  client.setQueryData(['token-consumption', range], report);
  client.setQueryData(['token-consumption', other], { ...report, range: other });
  const refresh = query.refresh(range);
  listener({ entries: [{ provider: 'codex', enabled: true, status: 'ready' }, { provider: 'claude', enabled: false, status: 'ready' }], generatedAt: '2026-09-15T10:01:00Z' });
  await setImmediate();
  for (const input of [range, other]) assert.deepEqual(client.getQueryData<ConsumptionReport>(['token-consumption', input])?.sources.map(source => source.source), ['codex']);
  finish(report); await refresh;
  assert.deepEqual(client.getQueryData<ConsumptionReport>(['token-consumption', range])?.sources.map(source => source.source), ['codex']);
  query.dispose(); assert.equal(unsubscribed, true); client.clear();
});
