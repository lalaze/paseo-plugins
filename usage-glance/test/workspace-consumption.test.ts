import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { workspaceResolver, readWorkspaceCatalog } from '../server/workspace-catalog.ts';
import { readWorkspaceSource, reconcileWorkspaceRows } from '../server/workspace-consumption.ts';
import { ConsumptionService } from '../server/consumption.ts';
import { emptyTokens, groupConsumption, totalTokens, type SourceReport } from '../shared/consumption.ts';
import { projectConsumptionReport } from '../shared/consumption-cache.ts';
import { createHostRegistry, cachedHostConsumption, type HostEntry } from '../client/hosts.ts';
import { combineHostConsumption } from '../client/multi-host-consumption.ts';

const range = { since: '2026-09-10', until: '2026-09-11', timezone: 'UTC' };
const a = { id: 'a', label: '主项目', directory: '/work/app' }, b = { id: 'b', label: '功能分支', directory: '/work/app/trees/feature' };
const catalog = workspaceResolver([a, b]);
const row = { ...emptyTokens(), date: range.since, model: 'gpt-5.6-sol', inferredModel: false, input: 100, output: 20 };

test('workspace matching respects titles, worktrees, path boundaries and ambiguous paths', () => {
  assert.equal(catalog.directory('/work/app/src')?.id, 'a');
  assert.equal(catalog.directory('/work/app/trees/feature/src/')?.id, 'b');
  assert.equal(catalog.directory('/work/application'), undefined);
  assert.equal(catalog.directory('app'), undefined);
  assert.equal(catalog.directory('/work/app/../other'), undefined);
  const windows = workspaceResolver([{ ...a, directory: 'C:\\Work\\App' }]);
  assert.equal(windows.directory('c:/work/app/src')?.id, 'a');
  const duplicates = workspaceResolver([a, { ...a, id: 'duplicate' }], [{ source: 'codex', sessionId: 'session', workspaceId: 'a', cwd: a.directory }]);
  assert.equal(duplicates.directory(a.directory), undefined);
  assert.equal(duplicates.session('codex', 'session', a.directory)?.id, 'a');
  assert.equal(duplicates.claudeProject('-work-app'), undefined);
  assert.equal(catalog.claudeProject('-work-app')?.id, 'a');
});

test('catalog includes Done, paginates, uses custom titles and detects a cursor cycle', async () => {
  const api: any = { workspaces: { list: async ({ page }: any) => ({ entries: page.cursor ? [{ id: b.id, name: 'feature', title: b.label, workspaceDirectory: b.directory, status: 'done' }] : [{ id: a.id, name: 'main', title: a.label, workspaceDirectory: a.directory, status: 'running' }, { id: 'archiving', name: 'gone', workspaceDirectory: '/gone', archivingAt: 'now' }], pageInfo: { hasMore: !page.cursor, nextCursor: page.cursor ? null : 'next' } }) }, agents: { list: async () => ({ entries: [{ agent: { provider: 'antigravity-hub', persistence: { sessionId: 'cascade' }, workspaceId: b.id, cwd: b.directory } }], pageInfo: { hasMore: false } }) } };
  const result = await readWorkspaceCatalog(api);
  assert.equal(result.directory(a.directory)?.label, a.label);
  assert.equal(result.directory(b.directory)?.label, b.label);
  assert.equal(result.directory('/gone'), undefined);
  assert.equal(result.session('antigravity', 'cascade')?.id, b.id);
  api.workspaces.list = async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: 'same' } });
  await assert.rejects(readWorkspaceCatalog(api), /不完整/);
});

test('unreconciled models remain unattributed without changing daily accounting or other models', () => {
  const daily = [row, { ...row, model: 'other' }];
  const reconciled = reconcileWorkspaceRows(daily, [{ ...row, workspace: a }, { ...row, model: 'other', input: 101, workspace: b }]);
  assert.equal(reconciled[0].workspace?.id, 'a');
  assert.equal(reconciled[1].workspace, undefined);
  assert.equal(reconciled.reduce((sum, item) => sum + totalTokens(item), 0), 240);
  assert.equal(reconcileWorkspaceRows([row], [{ ...row, cacheRead: 1, workspace: a }])[0].workspace, undefined);
});

test('workspace groups preserve unknown usage, separate identical workspace IDs on hosts, and match all other totals', () => {
  const source: SourceReport = { source: 'codex', status: 'ready', updatedAt: 'now', message: null, rows: [row, row], workspaceRows: [{ ...row, workspace: a }, row] };
  const sources = [{ ...source, host: { id: 'mac', label: 'Mac' } }, { ...source, host: { id: 'linux', label: 'Linux' } }];
  const groups = groupConsumption(sources, 'workspace');
  assert.equal(groups.length, 4);
  assert.equal(groups.filter(group => group.label === '未归属 Workspace').length, 2);
  assert.equal(new Set(groups.map(group => group.id)).size, 4);
  for (const by of ['workspace', 'source', 'model', 'vendor', 'host'] as const) assert.equal(groupConsumption(sources, by).reduce((sum, group) => sum + totalTokens(group), 0), 480);
  assert.equal(groupConsumption([{ ...source, workspaceRows: undefined }], 'workspace')[0].label, '未归属 Workspace');
});

test('workspace ranges are exact in service, host lookup and multi-host aggregation', async () => {
  const calls: string[] = [];
  const service = new ConsumptionService(async (_source, input) => { calls.push(input.since); return { rows: [row], workspaceRows: [{ ...row, workspace: a }], message: null }; }, Date.now, true);
  const today = { ...range, since: range.until };
  try {
    service.get(range, ['codex']); await setImmediate(); await setImmediate();
    service.get(today, ['codex']); await setImmediate(); await setImmediate();
    assert.deepEqual(calls, [range.since, today.since]);
    assert.ok(service.get(range, ['codex']).sources[0].workspaceRows);
    const report = service.get(range, ['codex']);
    assert.equal(projectConsumptionReport(report, today).sources[0].workspaceRows, undefined);
    const host: HostEntry = { id: 'host', label: 'Host', online: false, reports: new Map([['range', report]]), errors: new Map(), pending: new Map() };
    assert.equal(cachedHostConsumption(host, today, true), undefined);
    assert.equal(combineHostConsumption([host], today, true).sources.length, 0);
    assert.equal(combineHostConsumption([host], range, true).sources[0].workspaceRows?.[0].workspace?.id, 'a');
    assert.equal(createHostRegistry(true).exactRanges, true);
  } finally { service.dispose(); }
});

test('native Codex attribution keeps cross-day usage, forks, archived copies and renamed byte-identical backups in their workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-codex-'));
  const usage = (input: number) => ({ input_tokens: input, output_tokens: 20, cached_input_tokens: 50, reasoning_output_tokens: 0, total_tokens: input + 20 });
  const event = (timestamp: string, last: object, total = last) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { model: row.model, last_token_usage: last, total_token_usage: total } } });
  const parent = [{ type: 'session_meta', timestamp: '2026-09-10T08:00:00Z', payload: { id: 'parent', cwd: a.directory } }, event('2026-09-10T08:01:00Z', usage(100)), event('2026-09-11T08:01:00Z', usage(100), { ...usage(200), output_tokens: 40, cached_input_tokens: 100, total_tokens: 240 })];
  const files = {
    'sessions/2026/09/10/parent.jsonl': parent,
    'sessions/2026/09/10/parent-backup.jsonl': parent,
    'archived_sessions/2026/09/10/parent.jsonl': parent,
    'sessions/2026/09/11/child.jsonl': [{ type: 'session_meta', timestamp: '2026-09-11T09:00:00Z', payload: { id: 'child', cwd: b.directory, forked_from_id: 'parent' } }, event('2026-09-11T09:00:00Z', usage(100)), event('2026-09-11T09:00:00Z', usage(100), { ...usage(200), output_tokens: 40, cached_input_tokens: 100, total_tokens: 240 }), event('2026-09-11T09:03:00Z', usage(100), { ...usage(300), output_tokens: 60, cached_input_tokens: 150, total_tokens: 360 })],
  };
  try {
    for (const [name, records] of Object.entries(files)) { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n'); }
    const result = await readWorkspaceSource('codex', range, new AbortController().signal, catalog, { ...process.env, CODEX_HOME: root });
    assert.equal(result.message, null);
    assert.deepEqual(result.workspaceRows.map(item => [item.workspace?.id, totalTokens(item)]).sort(), [['a', 240], ['b', 120]]);
    const today = await readWorkspaceSource('codex', { ...range, since: range.until }, new AbortController().signal, catalog, { ...process.env, CODEX_HOME: root });
    assert.deepEqual(today.workspaceRows.map(item => [item.workspace?.id, totalTokens(item)]).sort(), [['a', 120], ['b', 120]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native Claude project, Kimi state and Grok summary metadata produce exact workspace token buckets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-native-'));
  const time = '2026-09-10T08:01:00Z';
  const claude = { type: 'assistant', timestamp: time, sessionId: 'claude', cwd: a.directory, message: { id: 'one', model: 'claude-test', role: 'assistant', usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 } } };
  const kimi = { type: 'usage.record', model: 'kimi-for-coding', usage: { inputOther: 100, output: 30, inputCacheRead: 70, inputCacheCreation: 20 }, usageScope: 'turn', time: Date.parse(time) };
  const grok = { timestamp: Date.parse(time) / 1000, params: { sessionId: 'grok-session', update: { sessionUpdate: 'turn_completed', usage: { inputTokens: 190, outputTokens: 30, cachedReadTokens: 70, cacheCreationTokens: 20, reasoningTokens: 10, totalTokens: 220 } }, _meta: { eventId: 'one' } } };
  try {
    for (const [name, value] of Object.entries({ 'projects/-work-app/session.jsonl': claude, 'sessions/project/session/agents/main/wire.jsonl': kimi, 'sessions/project/session/state.json': { id: 'session', cwd: b.directory }, 'sessions/project/grok-session/updates.jsonl': grok, 'sessions/project/grok-session/summary.json': { info: { id: 'grok-session', cwd: a.directory }, current_model_id: 'grok-4.6-build' } })) { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value) + '\n'); }
    for (const [source, variable, expected] of [['claude', 'CLAUDE_CONFIG_DIR', 'a'], ['kimi', 'KIMI_DATA_DIR', 'b'], ['grok', 'GROK_HOME', 'a']] as const) {
      const result = await readWorkspaceSource(source, range, new AbortController().signal, catalog, { ...process.env, [variable]: root });
      assert.equal(result.message, null);
      assert.equal(result.workspaceRows.length, 1);
      assert.equal(result.workspaceRows[0].workspace?.id, expected);
      assert.equal(totalTokens(result.workspaceRows[0]), 220);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
