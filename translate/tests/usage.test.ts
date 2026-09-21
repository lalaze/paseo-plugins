import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageLedger, parseUsage, translationUsageRoot } from '../server/usage';
import { createTranslationHandler, translateSelection } from '../server/translate';

const settings = { apiUrl: 'https://translate.example/v1/chat/completions', apiKey: 'secret-key', model: 'translate-model', fallbackApiUrl: '', fallbackApiKey: '', fallbackModel: '', englishLockModels: '' };
const reply = (usage?: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }], ...(usage === undefined ? {} : { usage }) }), { status: 200 });

test('ledger lives under PASEO_HOME unless overridden', () => {
  assert.equal(translationUsageRoot({}, '/home/test'), '/home/test/.paseo/translate/usage');
  assert.equal(translationUsageRoot({ PASEO_HOME: '/data/paseo' }, '/home/test'), '/data/paseo/translate/usage');
  assert.equal(translationUsageRoot({ PASEO_HOME: '/data/paseo', PASEO_TRANSLATE_USAGE_DIR: ' /ledger ' }, '/home/test'), '/ledger');
});

test('parses OpenAI-compatible usage and rejects incomplete or inconsistent counts', () => {
  assert.deepEqual(parseUsage({ usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }), { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: null });
  assert.deepEqual(parseUsage({ usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 10 } } }), { input: 120, output: 30, cacheRead: 100, cacheWrite: 0, reasoning: 10 });
  assert.deepEqual(parseUsage({ usage: { input_tokens: 5, output_tokens: 2 } }), { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null });
  // Cache never exceeds input; reasoning that exceeds output is treated as not provided.
  assert.deepEqual(parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 50 }, completion_tokens_details: { reasoning_tokens: 9 } } }), { input: 10, output: 4, cacheRead: 10, cacheWrite: 0, reasoning: null });
  assert.equal(parseUsage({ choices: [] }), null);
  assert.equal(parseUsage({ usage: { prompt_tokens: -1, completion_tokens: 3 } }), null);
  assert.equal(parseUsage({ usage: { prompt_tokens: 1.5, completion_tokens: 3 } }), null);
  assert.equal(parseUsage({ usage: { prompt_tokens: '12', completion_tokens: 3 } }), null);
  assert.equal(parseUsage(null), null);
});

test('records one ledger line per API answer, including fallback and content failures, without the source text', async () => {
  const entries: unknown[] = [];
  let calls = 0;
  const fetchStub: typeof fetch = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
    return reply({ prompt_tokens: 120, completion_tokens: 30 });
  };
  const fallbackSettings = { ...settings, fallbackApiUrl: 'https://backup.example/v1/chat/completions', fallbackApiKey: 'backup-key', fallbackModel: 'backup-model' };
  await translateSelection({ text: 'hello PRIVATE', target: 'zh-CN', settings: fallbackSettings }, fetchStub, entry => entries.push(entry));
  assert.equal(entries.length, 1);
  const [entry] = entries as { at: string; model: string; endpoint: string; usage: unknown }[];
  assert.equal(entry.model, 'backup-model'); assert.equal(entry.endpoint, 'fallback');
  assert.deepEqual(entry.usage, { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: null });
  assert.ok(Number.isFinite(Date.parse(entry.at)));
  assert.equal(JSON.stringify(entries).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(entries).includes('secret-key'), false);

  entries.length = 0;
  const noUsage: typeof fetch = async () => reply();
  await translateSelection({ text: 'hello', target: 'zh-CN', settings }, noUsage, entry => entries.push(entry));
  assert.deepEqual((entries[0] as { usage: unknown }).usage, null);

  entries.length = 0;
  const emptyContent: typeof fetch = async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 0 } }), { status: 200 });
  await assert.rejects(translateSelection({ text: 'hello', target: 'zh-CN', settings }, emptyContent, entry => entries.push(entry)), /missing choices/);
  assert.deepEqual((entries[0] as { usage: { input: number } }).usage.input, 7);
});

test('the handler appends monthly JSONL files and survives an unwritable ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paseo-translate-usage-'));
  try {
    const ledger = createUsageLedger(join(root, 'nested', 'usage'));
    await ledger.record({ at: '2026-09-20T14:00:00.000Z', model: 'translate-model', endpoint: 'primary', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null } });
    await ledger.record({ at: '2026-10-01T00:00:00.000Z', model: 'translate-model', endpoint: 'primary', usage: null });
    assert.deepEqual((await readdir(join(root, 'nested', 'usage'))).sort(), ['2026-09.jsonl', '2026-10.jsonl']);
    const lines = (await readFile(join(root, 'nested', 'usage', '2026-09.jsonl'), 'utf8')).trim().split('\n');
    assert.deepEqual(JSON.parse(lines[0]), { v: 1, at: '2026-09-20T14:00:00.000Z', model: 'translate-model', endpoint: 'primary', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null } });
    if (process.platform !== 'win32') assert.equal((await stat(join(root, 'nested', 'usage', '2026-09.jsonl'))).mode & 0o777, 0o600);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => reply({ prompt_tokens: 3, completion_tokens: 4 })) as typeof fetch;
    try {
      const handler = createTranslationHandler(ledger);
      await handler({ text: 'hello', target: 'zh-CN', settings });
      await ledger.record({ at: '2026-09-21T00:00:00.000Z', model: 'x', endpoint: 'primary', usage: null });
      assert.equal((await readFile(join(root, 'nested', 'usage', '2026-09.jsonl'), 'utf8')).trim().split('\n').length, 3);
      // A ledger rooted at a regular file cannot be created; translations still succeed.
      const broken = createTranslationHandler(createUsageLedger(join(root, 'nested', 'usage', '2026-09.jsonl', 'child')));
      assert.equal((await broken({ text: 'hello', target: 'zh-CN', settings })).translation, '你好');
    } finally { globalThis.fetch = originalFetch; }
  } finally { await rm(root, { recursive: true, force: true }); }
});
