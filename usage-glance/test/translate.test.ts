import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTranslateLedger, runTranslate, translateUsageRoot } from '../server/translate.ts';
import { consumptionRowSchema, enabledConsumptionSources, groupConsumption, sourceIds, totalTokens } from '../shared/consumption.ts';
import { localizeUsageMessage } from '../shared/i18n.ts';

const range = { since: '2026-09-10', until: '2026-09-10', timezone: 'UTC' };
const usage = { input: 120, output: 30, cacheRead: 100, cacheWrite: 0, reasoning: 10 };
const entry = (at: string, patch: object = {}) => ({ v: 1, at, model: 'gpt-4.1-mini', endpoint: 'primary', usage, ...patch });

async function fixture(files: Record<string, unknown[]>, check: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'paseo-translate-tokens-'));
  try {
    await mkdir(join(root, 'usage'), { recursive: true });
    for (const [name, entries] of Object.entries(files)) await writeFile(join(root, 'usage', name), entries.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n');
    await check(join(root, 'usage'));
  } finally { await rm(root, { recursive: true, force: true }); }
}
const read = (root: string, input = range) => runTranslate(input, new AbortController().signal, root);

test('translate resolves the same ledger directory as the translate plugin', () => {
  assert.equal(translateUsageRoot('/home/test', {}), '/home/test/.paseo/translate/usage');
  assert.equal(translateUsageRoot('/home/test', { PASEO_HOME: '/data/paseo' }), '/data/paseo/translate/usage');
  assert.equal(translateUsageRoot('/home/test', { PASEO_HOME: '/data/paseo', PASEO_TRANSLATE_USAGE_DIR: '/ledger' }), '/ledger');
});

test('translate is listed only once its ledger exists and never through Provider switches', async () => {
  assert.equal(await hasTranslateLedger(join(tmpdir(), 'paseo-translate-missing-' + Date.now())), false);
  await fixture({}, async root => {
    assert.equal(await hasTranslateLedger(root), true);
    assert.deepEqual(await read(root), { rows: [], message: null });
  });
  assert.deepEqual(await read(join(tmpdir(), 'paseo-translate-missing-' + Date.now())), { rows: [], message: null });
  assert.deepEqual(enabledConsumptionSources([{ provider: 'translate', enabled: true }, { provider: 'codex', enabled: true }]), ['codex']);
  assert.deepEqual(enabledConsumptionSources([{ provider: 'codex', enabled: true }], ['translate']), ['codex', 'translate']);
  assert.deepEqual(enabledConsumptionSources([], ['translate']), ['translate']);
  assert.deepEqual(enabledConsumptionSources([{ provider: 'codex', enabled: true }], ['codex']), ['codex']);
  assert.equal(sourceIds.at(-1), 'translate');
});

test('translate sums ledger calls per day and model in the requested zone and reports gaps', async () => {
  await fixture({
    '2026-09.jsonl': [
      entry('2026-09-10T08:00:00.000Z'),
      entry('2026-09-10T23:30:00.000Z', { model: 'backup-model', endpoint: 'fallback', usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null } }),
      entry('2026-09-10T09:00:00.000Z', { usage: null }),
      entry('2026-09-11T00:00:00.000Z'),
      '',
      'not json',
      entry('2026-09-10T10:00:00.000Z', { usage: { input: 1, output: 1, cacheRead: 5, cacheWrite: 0, reasoning: null } }),
      entry('2026-09-10T10:00:00.000Z', { model: '' , usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: null } }),
      entry('2026-09-10T10:00:00.000Z', { v: 2 }),
    ],
    '2026-08.jsonl': [entry('2026-08-31T23:00:00.000Z')],
    'notes.txt': ['ignored'],
  }, async root => {
    const result = await read(root);
    assert.deepEqual(result.rows.map(row => [row.date, row.model, totalTokens(row), row.inferredModel]), [['2026-09-10', 'backup-model', 7, false], ['2026-09-10', 'gpt-4.1-mini', 150, false], ['2026-09-10', 'Unrecorded model', 2, true]]);
    assert.equal(result.rows[1].cacheRead, 100); assert.equal(result.rows[1].reasoning, 10);
    assert.equal(result.rows[0].reasoning, null);
    result.rows.forEach(row => consumptionRowSchema.parse(row));
    assert.equal(result.message, '3 条翻译记录未能读取，统计可能不完整；1 次翻译调用未返回 token 数，未计入');
    assert.equal(localizeUsageMessage(result.message!), '3 translation records could not be read; totals may be incomplete. 1 translation calls returned no token counts and were excluded.');
    assert.deepEqual(await read(root), result);
    // Asia/Shanghai moves the 23:30Z call to the next day and pulls the August call into September.
    const shanghai = await read(root, { since: '2026-09-01', until: '2026-09-11', timezone: 'Asia/Shanghai' });
    assert.deepEqual(shanghai.rows.map(row => [row.date, row.model]), [['2026-09-01', 'gpt-4.1-mini'], ['2026-09-10', 'gpt-4.1-mini'], ['2026-09-10', 'Unrecorded model'], ['2026-09-11', 'backup-model'], ['2026-09-11', 'gpt-4.1-mini']]);
    assert.deepEqual(groupConsumption([{ source: 'translate', status: 'partial', updatedAt: null, ...result }], 'vendor').map(group => group.label), ['OpenAI', 'Unknown vendor']);
    assert.deepEqual(groupConsumption([{ source: 'translate', status: 'partial', updatedAt: null, ...result }], 'source').map(group => [group.label, totalTokens(group)]), [['Translate', 159]]);
  });
});

test('translate fails loudly when every ledger file is unreadable and honours cancellation', async () => {
  await fixture({ '2026-09.jsonl': ['garbage', '{"v":1}'] }, async root => {
    await assert.rejects(read(root), /本机翻译用量记录无法读取/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runTranslate(range, controller.signal, root), /读取已取消/);
  });
});
