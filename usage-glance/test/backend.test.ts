import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runCcusage } from '../server/ccusage.ts';
import { addTokens, emptyTokens, totalTokens, type SourceId } from '../shared/consumption.ts';

const range = { since: '2026-09-10', until: '2026-09-10', timezone: 'UTC' };
const time = '2026-09-10T08:01:00Z';
async function fixture(source: Exclude<SourceId, 'antigravity'>, files: Record<string, unknown[]>, expected: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  const root = await mkdtemp(join(tmpdir(), 'paseo-native-tokens-'));
  const variable = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', kimi: 'KIMI_DATA_DIR', grok: 'GROK_HOME' }[source];
  try {
    for (const [name, records] of Object.entries(files)) {
      const path = join(root, name); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, records.map(value => JSON.stringify(value)).join('\n') + '\n');
    }
    const run = (input = range) => runCcusage(source, input, new AbortController().signal, { ...process.env, [variable]: root });
    const report = await run(), total = emptyTokens();
    for (const row of report.rows) addTokens(total, row);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) assert.equal(total[key], expected[key], `${source} ${key}`);
    assert.equal(report.message, null);
    assert.deepEqual(await run(), report, 'rescan must replace totals, not accumulate');
    assert.equal((await run({ ...range, since: '2026-09-11', until: '2026-09-11' })).rows.length, 0);
    assert.equal(totalTokens(total), expected.input + expected.output);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('pinned Codex backend handles token_count plus request records, snapshots, archive copies and fork replay', async () => {
  const meta = (id: string, timestamp: string, parent?: string) => ({ type: 'session_meta', timestamp, payload: { id, ...(parent ? { forked_from_id: parent } : {}) } });
  const usage = (input: number, output: number, cached: number) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: 0, total_tokens: input + output });
  const event = (timestamp: string, last: object, total: object) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { model: 'gpt-5.6-sol', last_token_usage: last, total_token_usage: total } } });
  const first = usage(100, 20, 60), second = usage(50, 10, 30);
  const parent = [meta('parent', '2026-09-10T08:00:00Z'), { type: 'token_usage_record', timestamp: time, payload: { response_id: 'response-one', usage: first } }, event(time, first, first), event(time, first, first)];
  await fixture('codex', {
    'sessions/2026/09/10/parent.jsonl': parent,
    'archived_sessions/2026/09/10/parent.jsonl': parent,
    'sessions/2026/09/10/child.jsonl': [meta('child', '2026-09-10T09:00:00Z', 'parent'), event('2026-09-10T09:00:00Z', first, first), event('2026-09-10T09:02:00Z', second, usage(150, 30, 90))],
  }, { input: 150, output: 30, cacheRead: 90, cacheWrite: 0 });
});

test('pinned Claude backend counts messages without request IDs and deduplicates copied messages', async () => {
  const message = (id: string) => ({ type: 'assistant', timestamp: time, sessionId: 'claude-session', message: { id, model: 'glm-5.3-flash-free', role: 'assistant', usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 70, cache_creation_input_tokens: 20 } } });
  await fixture('claude', { 'projects/project/session.jsonl': [message('one'), message('one'), message('two')], 'projects/project/backup.jsonl': [message('one')] }, { input: 380, output: 60, cacheRead: 140, cacheWrite: 40 });
});

test('pinned Kimi backend uses turn usage without adding session totals', async () => {
  const record = { type: 'usage.record', model: 'kimi-for-coding', usage: { inputOther: 100, output: 30, inputCacheRead: 70, inputCacheCreation: 20 }, usageScope: 'turn', time: Date.parse(time) };
  await fixture('kimi', { 'sessions/project/session/agents/main/wire.jsonl': [record, { ...record, usageScope: 'session', time: Date.parse(time) + 1, usage: { inputOther: 1000, output: 300, inputCacheRead: 700, inputCacheCreation: 200 } }] }, { input: 190, output: 30, cacheRead: 70, cacheWrite: 20 });
});

test('pinned Grok backend deduplicates completed events and does not add usage.json session totals', async () => {
  const usage = { inputTokens: 100, outputTokens: 30, cachedReadTokens: 70, cacheCreationTokens: 20, reasoningTokens: 10, totalTokens: 130 };
  const event = { timestamp: Date.parse(time) / 1000, params: { sessionId: 'grok-session', update: { sessionUpdate: 'turn_completed', usage: { ...usage, modelUsage: { 'grok-4.6-build': usage } } }, _meta: { eventId: 'event-one' } } };
  await fixture('grok', { 'sessions/project/session/updates.jsonl': [event, event], 'sessions/project/session/usage.json': [{ session: { inputTokens: 999999, outputTokens: 888888 } }] }, { input: 100, output: 30, cacheRead: 70, cacheWrite: 20 });
});
