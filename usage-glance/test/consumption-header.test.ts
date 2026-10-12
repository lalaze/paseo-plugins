import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { consumptionHeaderSummary, consumptionTone, installConsumptionHeaders } from '../client/consumption-header';
import { createHostRegistry } from '../client/hosts';
import { createConsumptionQuery } from '../client/consumption-query';
import { emptyTokens, type ConsumptionReport } from '../shared/consumption';

const range = { since: '2026-10-01', until: '2026-10-31', timezone: 'UTC' };
const report = (input: number): ConsumptionReport => ({ range, scanning: false, sources: [{ source: 'codex', status: 'ready', updatedAt: '2026-10-12T12:00:00Z', message: null,
  rows: [{ ...emptyTokens(), input, output: 100, cacheRead: input, reasoning: 100, date: '2026-10-12', model: 'gpt', inferredModel: false },
    { ...emptyTokens(), input: 999_000_000, date: '2026-10-11', model: 'gpt', inferredModel: false }] }] });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('fixed consumption colors include exact boundaries and distinguish missing readings from zero', () => {
  assert.deepEqual([null, 0, 999_999_999, 1_000_000_000, 4_999_999_999, 5_000_000_000].map(consumptionTone), ['unknown', 'success', 'success', 'warning', 'warning', 'danger']);
  const missing: ConsumptionReport = { range, scanning: true, sources: [] };
  assert.equal(consumptionHeaderSummary(missing).total, null);
  assert.equal(consumptionHeaderSummary({ ...missing, scanning: false }).total, 0);
  assert.equal(consumptionHeaderSummary({ ...missing, scanning: false, sources: [{ source: 'codex', status: 'error', updatedAt: null, rows: [], message: 'failed' }] }).total, null);
});

test('workspace headers follow fleet updates, daily projections, errors, midnight and cleanup without RPCs', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const registry = createHostRegistry(), cleanups: (() => void)[] = [];
  const headers = new Map<string, any>();
  let workspaceListener: (update: any) => void = () => {}, subscribed = true, opened = '', clock = new Date('2026-10-12T23:59:00Z');
  const addHost = (id: string, input: number) => {
    const client = new QueryClient();
    const query = createConsumptionQuery(client, (async () => assert.fail('headers must reuse background data')) as never, { subscribe: () => () => {} });
    const registration = registry.register({ consumption: query }); registration.identify({ id, label: id });
    const seed = (value: ConsumptionReport) => client.setQueryData(['token-consumption', range], value);
    seed(report(input)); cleanups.push(() => { registration.dispose(); query.dispose(); client.clear(); });
    return { seed, registration };
  };
  const mac = addHost('mac', 5_000_000);
  const stop = installConsumptionHeaders({
    paseo: { workspaces: { subscribe: (listener: typeof workspaceListener) => { workspaceListener = listener; return () => { subscribed = false; }; }, list: async () => ({ entries: [{ id: 'terminal-only' }, { id: 'chat' }], pageInfo: { hasMore: false } }) } },
    addHeaderButton: ({ workspaceId, button }: any) => { headers.set(workspaceId, button); return { update: (patch: any) => headers.set(workspaceId, { ...headers.get(workspaceId), ...patch }), remove: () => headers.delete(workspaceId) }; },
    openSurface: (id: string) => { opened = id; },
  } as never, registry, tone => ({ success: 'green', warning: 'yellow', danger: 'red', unknown: 'gray' })[tone], 'UTC', () => clock);
  const dot = () => headers.get('chat').icon;
  try {
    await settle();
    assert.equal(headers.size, 2);
    assert.match(headers.get('chat').label, /5M/); assert.equal(dot(), 'green');
    assert.match(headers.get('chat').title, /5,000,100|5\.000\.100/);
    headers.get('chat').behavior.onPress(); assert.equal(opened, 'consumption');
    addHost('linux', 1_000_000_000); assert.match(headers.get('chat').label, /1\.01B|10\.05亿/); assert.equal(dot(), 'yellow');
    mac.seed(report(5_000_000_000)); assert.equal(dot(), 'red');
    mac.seed({ ...report(5_000_000_000), sources: [{ ...report(5_000_000_000).sources[0], status: 'partial' }] }); assert.match(headers.get('chat').label, /\*/);
    mac.registration.dispose(); assert.match(headers.get('chat').label, /6B.*\*|60亿.*\*/); assert.equal(dot(), 'red');
    clock = new Date('2026-10-13T00:01:00Z'); t.mock.timers.tick(30000);
    assert.match(headers.get('chat').label, /0M/); assert.equal(dot(), 'green');
    clock = new Date('2026-11-01T00:01:00Z'); t.mock.timers.tick(30000);
    assert.match(headers.get('chat').label, /—/); assert.equal(dot(), 'gray');
    workspaceListener({ kind: 'remove', id: 'chat' }); assert.equal(headers.has('chat'), false);
    workspaceListener({ kind: 'upsert', workspace: { id: 'new' } }); assert.equal(headers.has('new'), true);
    workspaceListener({ kind: 'upsert', workspace: { id: 'new', archivingAt: 'now' } }); assert.equal(headers.has('new'), false);
    stop(); assert.equal(headers.size, 0); assert.equal(subscribed, false);
    t.mock.timers.tick(60000); mac.seed(report(1)); await settle(); assert.equal(headers.size, 0);
  } finally { stop(); cleanups.forEach(cleanup => cleanup()); }
});
