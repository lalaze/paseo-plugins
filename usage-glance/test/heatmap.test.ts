import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMonthHeatmap, heatLevel, heatmapModelKey, monthRange, shiftMonth } from '../shared/heatmap.ts';
import { dateInZone, totalTokens, type ConsumptionRow, type SourceReport } from '../shared/consumption.ts';

const row = (date: string, model = 'gpt-5.6-sol', input = 100): ConsumptionRow => ({ date, model, input, output: 20, cacheRead: 60, cacheWrite: 10, reasoning: 5, inferredModel: false });
const source = (source: SourceReport['source'], rows: ConsumptionRow[]): SourceReport => ({ source, rows, status: 'ready', updatedAt: '2026-09-15T12:00:00Z', message: null });

test('month ranges and navigation handle leap years, year boundaries and invalid months', () => {
  assert.deepEqual(monthRange('2024-02', 'Asia/Shanghai'), { since: '2024-02-01', until: '2024-02-29', timezone: 'Asia/Shanghai' });
  assert.equal(monthRange('2025-02', 'UTC').until, '2025-02-28');
  assert.equal(monthRange('2026-12', 'UTC').until, '2026-12-31');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2025-12', 1), '2026-01');
  assert.throws(() => monthRange('2026-13', 'UTC'));
  assert.throws(() => monthRange('2026-2', 'UTC'));
});

test('calendar uses Monday-first weeks and fills four, five and six week months correctly', () => {
  const four = buildMonthHeatmap([], '2021-02', '2026-09-15');
  assert.equal(four.days.length, 28); assert.equal(four.weeks.length, 4); assert.equal(four.weeks[0][0]?.day, 1);
  const five = buildMonthHeatmap([], '2024-02', '2026-09-15');
  assert.equal(five.days.length, 29); assert.equal(five.weeks.length, 5); assert.equal(five.weeks[0][3]?.day, 1); assert.deepEqual(five.weeks[0].slice(0, 3), [null, null, null]);
  const six = buildMonthHeatmap([], '2026-03', '2026-09-15');
  assert.equal(six.weeks.length, 6); assert.equal(six.weeks[0][6]?.day, 1); assert.equal(six.weeks[5][1]?.day, 31);
  assert.equal(six.weeks.flat().filter(Boolean).length, 31);
});

test('monthly heatmap conserves daily/model totals without adding cache or reasoning twice', () => {
  const chart = buildMonthHeatmap([
    source('codex', [row('2026-09-01'), row('2026-09-01', 'gpt-5.6-sol', 200), row('2026-09-02', 'gpt-5.6-astra', 300), row('2026-08-31', 'out-of-month', 9000)]),
    source('antigravity', [row('2026-09-01', 'gpt-5.6-sol', 400)]),
  ], '2026-09', '2026-09-15');
  assert.equal(chart.total, 1080); assert.equal(chart.activeDays, 2); assert.equal(chart.peak, 760);
  assert.equal(chart.days[0].input, 700); assert.equal(chart.days[0].output, 60);
  assert.equal(chart.days[0].cacheRead, 180); assert.equal(chart.days[0].reasoning, 15);
  assert.equal(chart.models.length, 3); // Identical model names in different Providers remain selectable independently.
  assert.equal(chart.models.reduce((sum, model) => sum + totalTokens(model), 0), chart.total);
  assert.equal(chart.days.reduce((sum, day) => sum + day.models.reduce((sum, model) => sum + totalTokens(model), 0), 0), chart.total);
});

test('model filtering and provider removal recompute both colors and totals without carrying old data', () => {
  const codex = source('codex', [row('2026-09-01'), row('2026-09-03', 'gpt-5.6-sol', 500)]);
  const agy = source('antigravity', [row('2026-09-01', 'gpt-5.6-sol', 900)]);
  const selected = heatmapModelKey('codex', 'gpt-5.6-sol');
  const chart = buildMonthHeatmap([codex, agy], '2026-09', '2026-09-15', selected);
  assert.equal(chart.total, 640); assert.equal(chart.peak, 520); assert.equal(chart.models.length, 2);
  assert.equal(heatLevel(totalTokens(chart.days[0]), chart.peak), 1);
  assert.equal(heatLevel(totalTokens(chart.days[2]), chart.peak), 4);
  assert.equal(buildMonthHeatmap([agy], '2026-09', '2026-09-15', selected).total, 0);
  assert.equal(buildMonthHeatmap([], '2026-09', '2026-09-15').models.length, 0);
});

test('uses already localized row dates and distinguishes future calendar days', () => {
  const today = dateInZone(new Date('2026-09-14T20:00:00Z'), 'Asia/Shanghai');
  const chart = buildMonthHeatmap([source('grok', [row('2026-09-15', 'grok-4.6-build'), row('2026-09-16', 'future', 999)])], '2026-09', today);
  assert.equal(chart.days[14].future, false); assert.equal(totalTokens(chart.days[14]), 120);
  assert.equal(chart.days[15].future, true); assert.equal(totalTokens(chart.days[15]), 0);
  assert.equal(chart.models.length, 1); assert.equal(chart.total, 120);
  assert.deepEqual([0, 1, 25, 26, 50, 51, 75, 76, 100].map(value => heatLevel(value, 100)), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(heatLevel(0, 0), 0);
});
