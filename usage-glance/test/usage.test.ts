import assert from 'node:assert/strict';
import test from 'node:test';
import { balancePercent, findUsage, formatPercent, hasQuota, headerSummary, isStale, modelWindows, providerShortName, remaining, resetLabel, summary, type Usage } from '../shared/usage.ts';
import { headerSettings } from '../shared/settings.ts';

const usage = (patch: Partial<Usage> = {}): Usage => ({ providerId: 'codex', displayName: 'Codex', status: 'available', planLabel: null, windows: [], ...patch });

test('remaining percentages distinguish missing, zero, used, and fractional values', () => {
  assert.equal(remaining({ id: 'x', label: 'x' }), null);
  assert.equal(remaining({ id: 'x', label: 'x', usedPct: 80 }), 20);
  assert.equal(remaining({ id: 'x', label: 'x', remainingPct: 0, usedPct: 20 }), 0);
  assert.equal(remaining({ id: 'x', label: 'x', usedPct: NaN }), null);
  assert.equal(formatPercent(0.01), '<0.1%');
  assert.equal(formatPercent(99.99), '>99.9%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(100), '100%');
});

test('summary reports the limiting window without treating unknown values as zero', () => {
  const result = summary(usage({ windows: [
    { id: 'five', label: '5-hour', usedPct: 25 },
    { id: 'week', label: 'Weekly', remainingPct: 8 },
    { id: 'unknown', label: 'Unknown', remainingPct: null },
  ] }));
  assert.equal(result.label, '最低剩余 8%');
  assert.equal(result.tone, 'danger');
  assert.match(result.detail, /Weekly/);
  assert.equal(summary(usage()).label, '额度未知');
  assert.equal(summary(usage({ status: 'unavailable', windows: [{ id: 'old', label: 'old', remainingPct: 80 }] })).label, '额度暂不可用');
});

test('Antigravity uses the matching model group and only the explicit bridge alias', () => {
  const agy = usage({ providerId: 'antigravity-acp', windows: [
    { id: 'g', label: 'Gemini · Weekly limit', remainingPct: 80 },
    { id: 'c', label: 'Claude / GPT · 5-hour limit', remainingPct: 5 },
  ] });
  assert.equal(findUsage([agy], 'antigravity-hub'), agy);
  assert.equal(findUsage([agy], 'other-antigravity'), undefined);
  assert.equal(summary(agy, 'gemini-3-pro').label, '剩余 80%');
  assert.equal(summary(agy, 'claude-sonnet').label, '剩余 5%');
  assert.equal(modelWindows(agy, 'opaque-model-id').length, 2);
  assert.equal(summary(agy, null).label, '最低剩余 5%');
});

test('balances without known limits remain amounts and are not invented percentages', () => {
  const balance = { id: 'credits', label: 'Credits', unit: 'credits' as const, remaining: 50 };
  assert.equal(balancePercent(balance), null);
  assert.equal(summary(usage({ balances: [balance] })).label, '剩余 50 积分');
  assert.equal(balancePercent({ ...balance, limit: 100 }), 50);
  assert.equal(summary(usage({ balances: [{ ...balance, remaining: 0 }] })).tone, 'danger');
  assert.equal(balancePercent({ ...balance, limit: 0 }), null);
});

test('reset and freshness never imply an elapsed quota has already replenished', () => {
  const now = Date.parse('2026-09-12T10:00:00Z');
  assert.equal(resetLabel(undefined, now), null);
  assert.equal(resetLabel('invalid', now), null);
  assert.equal(resetLabel('2026-09-12T09:00:00Z', now), '已到重置时间，等待更新');
  assert.equal(resetLabel('2026-09-12T11:20:00Z', now), '1 小时 20 分钟后重置');
  assert.equal(isStale({ requestId: 'test', providers: [], fetchedAt: '2026-09-12T09:53:00Z' }, now), true);
  assert.equal(isStale({ requestId: 'test', providers: [], fetchedAt: '2026-09-12T09:56:00Z' }, now), false);
});

test('header identifies the lowest available quota and does not rank missing data as zero', () => {
  const codex = usage({ windows: [{ id: 'session', label: 'Session', remainingPct: 28 }] });
  const agy = usage({ providerId: 'antigravity-acp', displayName: 'Google Antigravity 2.0', windows: [{ id: 'week', label: 'Weekly', remainingPct: 88.4 }] });
  const unavailable = usage({ providerId: 'claude', status: 'unavailable', windows: [{ id: 'old', label: 'Old', remainingPct: 0 }] });
  const result = headerSummary([agy, unavailable, codex, usage({ providerId: 'unknown' })]);
  assert.equal(result.label, 'Codex 余28%');
  assert.match(result.detail, /所有可用额度中的最低剩余/);
  assert.equal(result.tone, 'ok');
  assert.equal(headerSummary([agy]).label, 'AGY 余88.4%');
  assert.equal(headerSummary([usage({ windows: [{ id: 'zero', label: 'Session', remainingPct: 0 }] })]).tone, 'danger');
  assert.equal(headerSummary([unavailable]).label, '额度 · 查看明细');
  assert.equal(headerSummary([]).tone, 'unknown');
});

test('header can pin a provider instead of the lowest remaining quota', () => {
  const codex = usage({ windows: [{ id: 'session', label: 'Session', remainingPct: 28 }] });
  const agy = usage({ providerId: 'antigravity-acp', displayName: 'Google Antigravity 2.0', windows: [{ id: 'week', label: 'Weekly', remainingPct: 88.4 }] });
  const kimi = usage({ providerId: 'kimi', displayName: 'Kimi', windows: [{ id: 'week', label: 'Weekly', remainingPct: 41 }] });
  const unavailable = usage({ providerId: 'claude', status: 'unavailable', displayName: 'Claude', windows: [{ id: 'old', label: 'Old', remainingPct: 0 }] });
  const pinned = headerSummary([agy, kimi, codex], 'antigravity-acp');
  assert.equal(pinned.label, 'AGY 余88.4%');
  assert.match(pinned.detail, /顶栏固定显示/);
  assert.equal(headerSummary([agy, kimi, codex], 'antigravity-hub').label, 'AGY 余88.4%');
  assert.equal(headerSummary([agy, kimi, unavailable], 'claude').label, 'Kimi 余41%');
  assert.match(headerSummary([agy, kimi, unavailable], 'claude').detail, /已选择的供应商暂无数据/);
  assert.equal(headerSummary([usage({ providerId: 'kimi', displayName: 'Kimi', balances: [{ id: 'credits', label: 'Credits', unit: 'credits', remaining: 50 }] })], 'kimi').label, 'Kimi 剩余 50 积分');
  assert.equal(headerSummary([agy, kimi, codex], 'missing').label, 'Codex 余28%');
  assert.match(headerSummary([agy, kimi, codex], 'missing').detail, /已选择的供应商暂无数据/);
  assert.equal(providerShortName(kimi), 'Kimi');
  assert.deepEqual(headerSettings.schema.parse({}), { providerId: null });
  assert.equal(headerSettings.schema.parse({ providerId: 'kimi' }).providerId, 'kimi');
});

test('providers without a remaining window or balance are omitted', () => {
  const copilot = usage({
    providerId: 'copilot',
    displayName: 'GitHub Copilot',
    details: [{ id: 'reset', label: 'Quota reset', value: '2026-10-01' }],
  });
  const emptyWindow = usage({ providerId: 'cursor', windows: [{ id: 'unknown', label: 'Unknown' }] });
  const zero = usage({ windows: [{ id: 'session', label: 'Session', remainingPct: 0 }] });
  const credits = usage({ balances: [{ id: 'credits', label: 'Credits', unit: 'usd', remaining: 0 }] });
  assert.equal(hasQuota(copilot), false);
  assert.equal(hasQuota(emptyWindow), false);
  assert.equal(hasQuota(usage({ status: 'unavailable', windows: [{ id: 'old', label: 'old', remainingPct: 80 }] })), false);
  assert.equal(hasQuota(zero), true);
  assert.equal(hasQuota(credits), true);
  assert.equal(headerSummary([copilot, zero]).label, 'Codex 余0%');
});
