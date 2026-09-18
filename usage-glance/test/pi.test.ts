import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { piSessionsRoot, runPi } from '../server/pi.ts';
import { consumptionRowSchema, groupConsumption, totalTokens } from '../shared/consumption.ts';

const range = { since: '2026-09-10', until: '2026-09-10', timezone: 'UTC' };
const timestamp = '2026-09-10T23:30:00Z';
const header = (id = 'parent') => ({ type: 'session', version: 3, id, timestamp, cwd: '/project' });
const usage = { input: 100, output: 30, cacheRead: 70, cacheWrite: 20, reasoning: 10, totalTokens: 220, cost: { total: 999 } };
const message = (id: string, patch: object = {}) => ({ type: 'message', id, timestamp, parentId: null, message: { role: 'assistant', model: 'glm-5', provider: 'zai', content: [{ type: 'text', text: 'PRIVATE transcript' }], timestamp: Date.parse(timestamp), usage, ...patch } });

async function fixture(files: Record<string, unknown[]>, check: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'paseo-pi-tokens-'));
  try {
    for (const [name, entries] of Object.entries(files)) {
      const path = join(root, name); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n');
    }
    await check(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const read = (root: string, input = range) => runPi(input, new AbortController().signal, root);

test('Pi resolves the agent root and tilde override', () => {
  assert.equal(piSessionsRoot('/home/test', {}), '/home/test/.pi/agent/sessions');
  assert.equal(piSessionsRoot('/home/test', { PI_CODING_AGENT_DIR: '~/custom-pi' }), '/home/test/custom-pi/sessions');
  assert.equal(piSessionsRoot('/home/test', { PI_CODING_AGENT_DIR: '/data/pi' }), '/data/pi/sessions');
});

test('Pi counts all branches once, deduplicates copies and forks, and preserves independent calls', async () => {
  const parent = [header(), message('one'), message('one'), message('two', { stopReason: 'aborted' })];
  await fixture({
    'project/parent.jsonl': parent,
    'backup/parent.jsonl': parent,
    'project/child.jsonl': [{ ...header('child'), parentSession: '/project/parent.jsonl' }, message('one'), message('three')],
    // A short entry ID collision with different payload must not drop a real call.
    'other/session.jsonl': [header('other'), message('one', { model: 'gpt-5' })],
  }, async root => {
    const result = await read(root);
    assert.equal(result.message, null);
    assert.equal(result.rows.reduce((sum, row) => sum + totalTokens(row), 0), 880);
    assert.equal(result.rows.find(row => row.model === 'glm-5')?.input, 570);
    assert.equal(result.rows.find(row => row.model === 'glm-5')?.cacheRead, 210);
    assert.equal(result.rows.find(row => row.model === 'glm-5')?.reasoning, 30);
    result.rows.forEach(row => consumptionRowSchema.parse(row));
    assert.deepEqual(await read(root), result);
    const workspace = { id: 'project', label: 'Project', directory: '/project' };
    const attributed = await runPi(range, new AbortController().signal, root, (_id, cwd) => cwd === workspace.directory ? workspace : undefined);
    assert.equal(attributed.rows.reduce((sum, row) => sum + totalTokens(row), 0), 880);
    assert.ok(attributed.rows.every(row => row.workspace?.id === workspace.id));
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal((await read(root, { ...range, timezone: 'Asia/Shanghai' })).rows.length, 0);
    assert.equal((await read(root, { ...range, since: '2026-09-11', until: '2026-09-11', timezone: 'Asia/Shanghai' })).rows.length, 2);
    assert.deepEqual(groupConsumption([{ source: 'pi', status: 'ready', updatedAt: null, ...result }], 'vendor').map(group => group.label), ['Zhipu AI', 'OpenAI']);
  });
});

test('Pi includes recorded summary usage without counting context size or inferring its model', async () => {
  await fixture({ 'project/s.jsonl': [header(),
    { type: 'model_change', modelId: 'gpt-5', timestamp },
    { type: 'compaction', id: 'compact', timestamp, usage: { ...usage, reasoning: undefined }, tokensBefore: 50000 },
    { type: 'branch_summary', id: 'branch', timestamp, usage },
    { type: 'compaction', id: 'old', timestamp, tokensBefore: 90000 },
    message('missing-model', { model: undefined, usage: { ...usage, reasoning: undefined } }),
    { type: 'message', message: { role: 'user', content: 'PRIVATE' } },
  ] }, async root => {
    const result = await read(root);
    assert.equal(result.message, null);
    assert.deepEqual(result.rows, [{ date: range.since, model: 'Unrecorded model', inferredModel: true, input: 570, output: 90, cacheRead: 210, cacheWrite: 60, reasoning: null }]);
  });
});

test('Pi copied history with conflicting workspace ownership remains unattributed once', async () => {
  const workspaces = [{ id: 'one', label: 'One', directory: '/one' }, { id: 'two', label: 'Two', directory: '/two' }];
  await fixture({ 'one.jsonl': [{ ...header(), cwd: '/one' }, message('shared'), message('only-one')], 'two.jsonl': [{ ...header('fork'), cwd: '/two' }, message('shared')] }, async root => {
    const result = await runPi(range, new AbortController().signal, root, (_id, cwd) => workspaces.find(item => item.directory === cwd));
    assert.equal(result.rows.reduce((sum, row) => sum + totalTokens(row), 0), 440);
    assert.equal(totalTokens(result.rows.find(row => !row.workspace)!), 220);
    assert.equal(totalTokens(result.rows.find(row => row.workspace?.id === 'one')!), 220);
  });
});

test('Pi v1 entries without IDs retain repeated calls and deduplicate file copies', async () => {
  const entry = { ...message('legacy'), id: undefined };
  const entries = [{ ...header(), version: undefined }, entry, entry];
  await fixture({ 'old.jsonl': entries, 'copy.jsonl': entries }, async root => {
    assert.equal((await read(root)).rows[0].input, 380);
  });
});

test('Pi reports malformed records, incomplete writes, and unsupported versions without hiding valid usage', async () => {
  await fixture({ 'good.jsonl': [header(), message('good'), message('bad', { usage: { ...usage, input: -1 } }), message('missing', { usage: undefined }), '{"PRIVATE":'],
    'future.jsonl': [{ kind: 'header', version: 4 }],
  }, async root => {
    const result = await read(root);
    assert.equal(result.rows.length, 1);
    assert.equal(totalTokens(result.rows[0]), 220);
    assert.match(result.message!, /4 个 Pi/);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  });
  await fixture({ 'broken.jsonl': ['PRIVATE invalid JSON'] }, async root => {
    await assert.rejects(read(root), /本机 Pi 用量记录无法读取/);
  });
});

test('Pi distinguishes absent data from read errors and supports cancellation', async () => {
  await fixture({}, async root => {
    assert.deepEqual(await read(join(root, 'absent')), { rows: [], message: null });
    await writeFile(join(root, 'not-directory'), 'PRIVATE');
    await assert.rejects(read(join(root, 'not-directory')), /本机 Pi/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runPi(range, controller.signal, root), { name: 'AbortError' });
  });
});
