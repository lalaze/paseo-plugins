import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { codebuddySessionsRoot, runCodebuddy } from '../server/codebuddy.ts';
import { consumptionRowSchema, groupConsumption, totalTokens } from '../shared/consumption.ts';

const range = { since: '2026-09-10', until: '2026-09-10', timezone: 'UTC' };
const timestamp = '2026-09-10T23:30:00Z';
const meta = (sessionId = 'session') => ({ type: 'session-meta', id: `meta-${sessionId}`, sessionId, timestamp: Date.parse(timestamp) });
const usage = { requests: 1, inputTokens: 100, outputTokens: 30, totalTokens: 130, inputTokensDetails: [{ cached_tokens: 70 }], outputTokensDetails: [{ reasoning_tokens: 10 }] };
const rawUsage = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, cache_creation_input_tokens: 20 };
const call = (id: string, patch: object = {}) => ({ id, type: 'function_call', name: 'Read', callId: `call-${id}`, timestamp: Date.parse(timestamp), sessionId: 'session', cwd: '/project', arguments: 'PRIVATE arguments', providerData: { model: 'hy4-preview-f', usage, rawUsage }, ...patch });
const assistant = (id: string, patch: object = {}) => ({ id, type: 'message', role: 'assistant', status: 'completed', timestamp: Date.parse(timestamp), sessionId: 'session', cwd: '/project', content: [{ type: 'output_text', text: 'PRIVATE transcript' }], providerData: { model: 'hy4-preview-f', usage, rawUsage }, ...patch });

async function fixture(files: Record<string, unknown[]>, check: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'paseo-codebuddy-tokens-'));
  try {
    for (const [name, entries] of Object.entries(files)) {
      const path = join(root, name); await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n');
    }
    await check(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const read = (root: string, input = range) => runCodebuddy(input, new AbortController().signal, root);

test('CodeBuddy resolves the projects root and tilde override', () => {
  assert.equal(codebuddySessionsRoot('/home/test', {}), '/home/test/.codebuddy/projects');
  assert.equal(codebuddySessionsRoot('/home/test', { CODEBUDDY_CONFIG_DIR: '~/custom-buddy' }), '/home/test/custom-buddy/projects');
  assert.equal(codebuddySessionsRoot('/home/test', { CODEBUDDY_CONFIG_DIR: '/data/buddy' }), '/data/buddy/projects');
});

test('CodeBuddy counts every recorded model request once, deduplicates copies and preserves independent calls', async () => {
  const session = [meta(), call('one'), call('one'), assistant('two')];
  await fixture({
    'project/session.jsonl': session,
    'backup/session.jsonl': session,
    'project/child.jsonl': [meta('child'), call('one'), call('three')],
    // A record ID reused by a different payload must not drop a real call.
    'other/session.jsonl': [meta('other'), call('one', { providerData: { model: 'deepseek-v4.1-flash', usage, rawUsage } })],
  }, async root => {
    const result = await read(root);
    assert.equal(result.message, null);
    assert.equal(result.rows.reduce((sum, row) => sum + totalTokens(row), 0), 600);
    const hunyuan = result.rows.find(row => row.model === 'hy4-preview-f')!;
    assert.equal(hunyuan.input, 360);
    assert.equal(hunyuan.output, 90);
    assert.equal(hunyuan.cacheRead, 210);
    assert.equal(hunyuan.cacheWrite, 60);
    assert.equal(hunyuan.reasoning, 30);
    result.rows.forEach(row => consumptionRowSchema.parse(row));
    assert.deepEqual(await read(root), result);
    const workspace = { id: 'project', label: 'Project', directory: '/project' };
    const attributed = await runCodebuddy(range, new AbortController().signal, root, (_id, cwd) => cwd === workspace.directory ? workspace : undefined);
    assert.equal(attributed.rows.reduce((sum, row) => sum + totalTokens(row), 0), 600);
    assert.ok(attributed.rows.every(row => row.workspace?.id === workspace.id));
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal((await read(root, { ...range, timezone: 'Asia/Shanghai' })).rows.length, 0);
    assert.equal((await read(root, { ...range, since: '2026-09-11', until: '2026-09-11', timezone: 'Asia/Shanghai' })).rows.length, 2);
    assert.deepEqual(groupConsumption([{ source: 'codebuddy', status: 'ready', updatedAt: null, ...result }], 'vendor').map(group => group.label), ['Tencent', 'DeepSeek']);
  });
});

test('CodeBuddy skips steps and messages without recorded usage', async () => {
  await fixture({ 'project/s.jsonl': [meta(),
    { id: 'announce', type: 'function_call', name: 'Bash', timestamp: Date.parse(timestamp), sessionId: 'session', cwd: '/project' },
    { id: 'user', type: 'message', role: 'user', timestamp: Date.parse(timestamp), sessionId: 'session', cwd: '/project', content: 'PRIVATE' },
    { id: 'bare', type: 'function_call', name: 'Glob', timestamp: Date.parse(timestamp), sessionId: 'session', cwd: '/project', providerData: { model: 'hy4-preview-f', stepSeq: 4 } },
    assistant('final'),
  ] }, async root => {
    const result = await read(root);
    assert.equal(result.message, null);
    assert.equal(result.rows.length, 1);
    assert.equal(totalTokens(result.rows[0]), 150);
  });
});

test('CodeBuddy accepts totals with or without cache writes and rejects inconsistent records', async () => {
  const big = { requests: 1, inputTokens: 200, outputTokens: 30, inputTokensDetails: [{ cached_tokens: 70 }], outputTokensDetails: [{ reasoning_tokens: 10 }] };
  await fixture({ 's.jsonl': [meta(),
    call('excluded-write', { providerData: { model: 'hy4-preview-f', usage: { ...big, totalTokens: 230 }, rawUsage } }),
    call('included-write', { providerData: { model: 'hy4-preview-f', usage: { ...big, totalTokens: 250 }, rawUsage } }),
    call('no-write', { providerData: { model: 'hy4-preview-f', usage: { ...big, totalTokens: 230 }, rawUsage: { ...rawUsage, cache_creation_input_tokens: 0 } } }),
    call('mismatch', { providerData: { model: 'hy4-preview-f', usage: { ...big, totalTokens: 999 }, rawUsage } }),
    call('overflow', { providerData: { model: 'hy4-preview-f', usage: { ...big, totalTokens: 230, inputTokensDetails: [{ cached_tokens: 500 }] }, rawUsage } }),
  ] }, async root => {
    const result = await read(root);
    assert.equal(result.rows.length, 1);
    // Each kept record: input 200 + 20 cache write, except no-write: 200 + 0.
    assert.equal(result.rows[0].input, 640);
    assert.equal(result.rows[0].cacheWrite, 40);
    assert.equal(result.rows[0].output, 90);
    assert.match(result.message!, /2 个 CodeBuddy/);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  });
});

test('CodeBuddy copied history with conflicting workspace ownership remains unattributed once', async () => {
  const workspaces = [{ id: 'one', label: 'One', directory: '/one' }, { id: 'two', label: 'Two', directory: '/two' }];
  await fixture({
    'one.jsonl': [meta('a'), call('shared', { sessionId: 'a', cwd: '/one' }), call('only-one', { sessionId: 'a', cwd: '/one' })],
    'two.jsonl': [meta('b'), call('shared', { sessionId: 'b', cwd: '/two' })],
  }, async root => {
    const result = await runCodebuddy(range, new AbortController().signal, root, (_id, cwd) => workspaces.find(item => item.directory === cwd));
    assert.equal(result.rows.reduce((sum, row) => sum + totalTokens(row), 0), 300);
    assert.equal(totalTokens(result.rows.find(row => !row.workspace)!), 150);
    assert.equal(totalTokens(result.rows.find(row => row.workspace?.id === 'one')!), 150);
  });
});

test('CodeBuddy reports malformed records and unreadable data without hiding valid usage', async () => {
  await fixture({ 'good.jsonl': [meta(), call('good'), call('bad', { providerData: { model: 'hy4-preview-f', usage: { ...usage, inputTokens: -1 } } }), '{"PRIVATE":'], 'empty.jsonl': [] }, async root => {
    const result = await read(root);
    assert.equal(result.rows.length, 1);
    assert.equal(totalTokens(result.rows[0]), 150);
    assert.match(result.message!, /3 个 CodeBuddy/);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  });
  await fixture({ 'broken.jsonl': ['PRIVATE invalid JSON'] }, async root => {
    await assert.rejects(read(root), /本机 CodeBuddy 用量记录无法读取/);
  });
});

test('CodeBuddy distinguishes absent data from read errors and supports cancellation', async () => {
  await fixture({}, async root => {
    assert.deepEqual(await read(join(root, 'absent')), { rows: [], message: null });
    await writeFile(join(root, 'not-directory'), 'PRIVATE');
    await assert.rejects(read(join(root, 'not-directory')), /本机 CodeBuddy/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runCodebuddy(range, controller.signal, root), { name: 'AbortError' });
  });
});
