import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompress } from 'node:zlib';
import { promisify } from 'node:util';
import { deepseekSessionsRoot, runDeepseek } from '../server/deepseek.ts';
import { groupConsumption, modelVendor, totalTokens } from '../shared/consumption.ts';

const compress = promisify(zstdCompress);
const range = { since: '2026-09-10', until: '2026-09-10', timezone: 'UTC' };
const at = (hour: number) => Date.parse('2026-09-10T00:00:00Z') + hour * 3600000;
const meta = (id: string, cwd = '/project') => ({ type: 'session', version: 4, id, createdAt: at(0), cwd, isSeeded: false });
const header = (model: string, hour = 1) => ({ type: 'request/header', seq: 1, time: at(hour), data: { header: { config: { provider: 'workbuddy', model } } } });
const usage = (input: number, output: number, cacheRead = 0) => ({ inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: output, totalTokens: input + cacheRead + output });
const attempt = (turn: number, step: number, value: unknown, hour = 2) => ({ type: 'assistant/attempt', seq: 2, time: at(hour), data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: value } }, { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'completed' } } }] } });
const message = (turn: number, step: number, value: unknown, hour = 2) => ({ type: 'assistant/message', seq: 3, time: at(hour), data: { turn, step, usage: value } });
const retryStarted = (turn: number, step: number) => ({ type: 'llm/retry-started', seq: 1, time: at(1), data: { turn, step, retry: 1 } });

async function writeFrame(lines: unknown[]) {
  // DSH appends one checksummed frame per durable batch.
  const chunks = [];
  for (let index = 0; index < lines.length; index += 3) chunks.push(await compress(Buffer.from(lines.slice(index, index + 3).map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n')));
  return Buffer.concat(chunks);
}
async function fixture(files: Record<string, { entries: unknown[]; frames?: boolean }>, check: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'paseo-dsh-tokens-'));
  try {
    for (const [name, { entries, frames = true }] of Object.entries(files)) {
      const path = join(root, name); await mkdir(dirname(path), { recursive: true });
      const lines = entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry));
      await writeFile(path, frames ? await writeFrame(lines) : lines.join('\n') + '\n');
    }
    await check(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const read = (root: string, input = range) => runDeepseek(input, new AbortController().signal, root);

test('DeepSeek Harness resolves the provider home and DSH_HOME overrides', () => {
  assert.equal(deepseekSessionsRoot('/home/test', {}), '/home/test/.local/share/paseo/providers/deepseek-harness/home/sessions');
  assert.equal(deepseekSessionsRoot('/home/test', { DSH_HOME: '~/dsh' }), '/home/test/dsh/sessions');
  assert.equal(deepseekSessionsRoot('/home/test', { DSH_HOME: '/data/dsh' }), '/data/dsh/sessions');
});

test('DeepSeek Harness folds retries and replacements per step, like its token meter', async () => {
  const lines = [
    meta('session'), header('cn:deepseek-v4.1-flash'),
    // A failed attempt reports zero usage and is ignored.
    attempt(1, 1, usage(0, 0)),
    // Replacement within one step: only the increase is new spending.
    attempt(1, 2, usage(100, 10), 3), attempt(1, 2, usage(150, 30), 4),
    // A retry opens a new scope; its usage adds on top of the previous attempt.
    retryStarted(1, 3), attempt(1, 3, usage(60, 5), 5),
    // The settled message repeats the streamed usage; it must not add again.
    message(1, 3, usage(60, 5), 5),
  ];
  await fixture({ '--project--/session/session.v4.jsonl.zstd': { entries: lines } }, async root => {
    const result = await read(root);
    assert.equal(result.message, null);
    assert.equal(result.rows.length, 1);
    const [row] = result.rows;
    assert.deepEqual(Object.keys(row).sort(), ['cacheRead', 'cacheWrite', 'date', 'inferredModel', 'input', 'model', 'output', 'reasoning']);
    assert.equal(row.date, '2026-09-10');
    assert.equal(row.model, 'cn:deepseek-v4.1-flash');
    // Step 2 keeps its last sample (150 + 30), step 3 contributes its own 60 + 5.
    assert.equal(totalTokens(row), 245);
    assert.equal(row.input, 210);
    assert.equal(row.output, 35);
    assert.equal(row.reasoning, null);
    assert.deepEqual(await read(root), result, 'rescan must replace totals, not accumulate');
    assert.equal((await runDeepseek({ ...range, since: '2026-09-11', until: '2026-09-11' }, new AbortController().signal, root)).rows.length, 0);
    // A copy of the same session in a plaintext log elsewhere does not add the session twice.
    const copy = join(root, 'copy/session'); await mkdir(copy, { recursive: true });
    await writeFile(join(copy, 'session.v4.jsonl'), lines.slice(2).map(entry => JSON.stringify(entry)).join('\n') + '\n');
    assert.equal(totalTokens((await read(root)).rows[0]), 245);
  });
});

test('DeepSeek Harness separates cache buckets, dates in the viewer time zone and attributes workspaces', async () => {
  await fixture({
    '--late--/session/session.v4.jsonl': { frames: false, entries: [
      // 23:30 UTC is already the next day in Tokyo.
      meta('late', '/work/late'),
      header('gpt-6.1-sol', 23),
      { ...attempt(1, 1, usage(40, 5, 60), 24), time: Date.parse('2026-09-10T23:30:00Z') },
      // A torn tail line is discarded.
      '{"type":"assistant/attempt","seq":9,',
    ] },
    '--old--/session/session.v2.jsonl.zstd': { entries: [{ type: 'session', version: 2, id: 'old', cwd: '/work/old' }, attempt(1, 1, usage(999, 999), 2)] },
    '--unknown--/session/session.v4.jsonl.zstd': { entries: [meta('unknown'), { type: 'assistant/attempt', time: 0, data: { turn: 1, step: 1, stream: [] } }] },
  }, async root => {
    const workspace = { id: 'late', label: 'Late', directory: '/work/late' };
    const resolveWorkspace = (id?: string, cwd?: string) => id === 'late' && cwd === '/work/late' ? workspace : undefined;
    const utc = await runDeepseek({ ...range, since: '2026-09-10', until: '2026-09-11' }, new AbortController().signal, root, resolveWorkspace);
    assert.equal(utc.rows.length, 1);
    assert.equal(utc.rows[0].date, '2026-09-10');
    const tokyo = await runDeepseek({ ...range, since: '2026-09-10', until: '2026-09-11', timezone: 'Asia/Tokyo' }, new AbortController().signal, root, resolveWorkspace);
    assert.equal(tokyo.rows.length, 1);
    assert.equal(tokyo.rows[0].date, '2026-09-11');
    assert.equal(tokyo.rows[0].input, 100);
    assert.equal(tokyo.rows[0].cacheRead, 60);
    assert.equal(tokyo.rows[0].output, 5);
    assert.equal(tokyo.rows[0].workspace?.id, 'late');
    // Retired v2 generations and unreadable lines warn without failing the readable session.
    assert.match(tokyo.message ?? '', /未能读取/);
    const report = tokyo.rows.map(row => ({ ...row }));
    assert.equal(groupConsumption([{ source: 'deepseek', status: 'ready', updatedAt: null, message: null, rows: report }], 'source')[0].label, 'DeepSeek Harness');
    assert.equal(modelVendor('gpt-6.1-sol', 'deepseek'), 'OpenAI');
  });
});

test('DeepSeek Harness reports unreadable files instead of an empty result', async () => {
  // Corrupt frames fail their file; the partial report names it instead of failing the whole read.
  await fixture({ '--broken--/session/session.v4.jsonl.zstd': { frames: false, entries: ['not a zstd frame'] } }, async broken => {
    // Nothing readable in the scan reports an error instead of an empty result.
    await assert.rejects(read(broken), error => error instanceof Error && error.message === '本机 DeepSeek Harness 用量记录无法读取，请检查格式和读取权限');
    const readable = join(broken, '--ok--/session'); await mkdir(readable, { recursive: true });
    await writeFile(join(readable, 'session.v4.jsonl'), [meta('ok'), attempt(1, 1, usage(7, 3))].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    // One corrupt file warns; the readable session still reports.
    const brokenRead = await read(broken);
    assert.equal(totalTokens(brokenRead.rows[0]), 10);
    assert.match(brokenRead.message ?? '', /^1 个 DeepSeek Harness 文件或记录未能读取/);
  });
});

test('DeepSeek model vendors strip reseller prefixes', () => {
  assert.equal(modelVendor('cn:deepseek-v4.1-flash', 'deepseek'), 'DeepSeek');
  assert.equal(modelVendor('openai/gpt-5.6-sol', 'deepseek'), 'OpenAI');
  assert.equal(modelVendor('anthropic/claude-sonnet-5', 'deepseek'), 'Anthropic');
});
