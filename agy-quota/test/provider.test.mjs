import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { locate, fixture } from '../patch.mjs';
const target = locate(process.env.PASEO_PATCH_TEST_CLI);
const f = fixture(target);
after(() => f.cleanup());
const { quotaWindows, AntigravityQuotaProvider } = await import(f.module);
const { ProviderUsageSchema } = await import(pathToFileURL(target.req.resolve('@getpaseo/protocol/messages')).href);
const logger = { child() { return this; }, debug() {} };
const payload = (fraction, resetTime = '2026-09-11T03:33:21Z') => ({ response: { groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: fraction, resetTime }] }] } });

test('quota direction, rounding, boundaries, reset time and protocol validation', async () => {
  for (const [remaining, used] of [[0, 100], [1, 0], [0.79769087, 20.23]]) {
    const provider = new AntigravityQuotaProvider({ logger, readQuota: async parse => parse(payload(remaining)) });
    const result = await provider.fetchUsage();
    assert.equal(result.windows[0].usedPct, used);
    assert.equal(result.windows[0].resetsAt, '2026-09-11T03:33:21.000Z');
    assert.equal(result.windows[0].label, 'Gemini Models · Weekly limit');
    assert.equal(result.windows[0].tone, used === 100 ? 'danger' : 'ok');
    assert.equal(ProviderUsageSchema.safeParse(result).success, true);
  }
});
test('missing, invalid and availability-only data never become zero usage', () => {
  for (const value of [undefined, null, '1', NaN, Infinity, -1, 1.01]) assert.deepEqual(quotaWindows(payload(value)), []);
  assert.deepEqual(quotaWindows({ models: { gemini: { available: true } } }), []);
  assert.equal(quotaWindows(payload(0.5, 'invalid'))[0].resetsAt, null);
});
test('four independent limits, nested legacy fractions and duplicate suppression', () => {
  const groups = ['Gemini Models', 'Claude and GPT models'].map((displayName, i) => ({ displayName, buckets: ['weekly', '5h'].map(window => ({ bucketId: `${i}-${window}`, window, remaining: { remainingFraction: 0.5 } })) }));
  groups[0].buckets.push(groups[0].buckets[0]);
  const windows = quotaWindows({ response: { groups } });
  assert.equal(windows.length, 4);
  assert.equal(new Set(windows.map(x => x.id)).size, 4);
  assert.equal(windows[1].label, 'Gemini Models · 5-hour limit');
});
test('GetUserStatus fallback uses only explicit model quotaInfo', () => {
  const windows = quotaWindows({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini Pro', modelOrAlias: { model: 'pro' }, quotaInfo: { remainingFraction: 0.75 } }, { label: 'Unknown' }] } } });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPct, 25);
});
test('errors become unavailable without leaking raw exception content', async () => {
  const p = new AntigravityQuotaProvider({ logger, readQuota: async () => { throw new Error('private credential'); } });
  const r = await p.fetchUsage();
  assert.equal(r.status, 'unavailable');
  assert.equal(JSON.stringify(r).includes('private'), false);
});
test('simultaneous refreshes share one read and a later refresh reads again', async () => {
  let calls = 0;
  const p = new AntigravityQuotaProvider({ logger, readQuota: async parse => { calls++; await new Promise(r => setTimeout(r, 10)); return parse(payload(1)); } });
  await Promise.all([p.fetchUsage(), p.fetchUsage(), p.fetchUsage()]);
  assert.equal(calls, 1);
  await p.fetchUsage();
  assert.equal(calls, 2);
});
