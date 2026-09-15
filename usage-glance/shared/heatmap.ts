import { addTokens, emptyTokens, totalTokens, validDate, type ConsumptionRange, type ModelTotal, type SourceId, type SourceReport, type Tokens } from './consumption';

export function monthRange(month: string, timezone: string): ConsumptionRange {
  if (!/^\d{4}-\d{2}$/.test(month) || !validDate(`${month}-01`)) throw new Error('月份无效');
  const end = new Date(`${month}-01T12:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { since: `${month}-01`, until: end.toISOString().slice(0, 10), timezone };
}
export function shiftMonth(month: string, delta: number): string {
  monthRange(month, 'UTC');
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  const next = date.toISOString().slice(0, 7);
  monthRange(next, 'UTC');
  return next;
}
export const heatmapModelKey = (source: SourceId, model: string, hostId?: string) => JSON.stringify(hostId ? [hostId, source, model] : [source, model]);
export type HeatmapModel = ModelTotal & { key: string };
export type HeatmapDay = Tokens & { date: string; day: number; future: boolean; models: HeatmapModel[] };
export type MonthHeatmap = { models: HeatmapModel[]; days: HeatmapDay[]; weeks: (HeatmapDay | null)[][]; total: number; peak: number; activeDays: number };

/** Rows already use the requested timezone. Cache/reasoning remain token subsets. */
export function buildMonthHeatmap(sources: SourceReport[], month: string, today: string, selectedModel: string | null = null): MonthHeatmap {
  const range = monthRange(month, 'UTC');
  const days: HeatmapDay[] = Array.from({ length: Number(range.until.slice(-2)) }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    return { ...emptyTokens(), date, day: index + 1, future: date > today, models: [] };
  });
  const models = new Map<string, HeatmapModel>();
  for (const source of sources) for (const row of source.rows) {
    if (row.date < range.since || row.date > range.until || row.date > today) continue;
    const key = heatmapModelKey(source.source, row.model, source.host?.id);
    const makeModel = (): HeatmapModel => ({ ...emptyTokens(), key, source: source.source, model: row.model, inferredModel: row.inferredModel, ...(source.host ? { host: source.host } : {}) });
    let model = models.get(key);
    if (!model) { model = makeModel(); models.set(key, model); }
    addTokens(model, row); model.inferredModel ||= row.inferredModel;
    if (selectedModel !== null && key !== selectedModel) continue;
    const day = days[Number(row.date.slice(-2)) - 1];
    addTokens(day, row);
    let dailyModel = day.models.find(value => value.key === key);
    if (!dailyModel) { dailyModel = makeModel(); day.models.push(dailyModel); }
    addTokens(dailyModel, row); dailyModel.inferredModel ||= row.inferredModel;
  }
  for (const day of days) day.models.sort((a, b) => totalTokens(b) - totalTokens(a));
  const offset = (new Date(`${range.since}T12:00:00Z`).getUTCDay() + 6) % 7;
  const cells: (HeatmapDay | null)[] = [...Array<null>(offset).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7));
  return { models: [...models.values()].sort((a, b) => totalTokens(b) - totalTokens(a)), days, weeks,
    total: days.reduce((sum, day) => sum + totalTokens(day), 0), peak: Math.max(0, ...days.map(totalTokens)), activeDays: days.filter(day => totalTokens(day) > 0).length };
}

/** Four equal bands relative to this selected model/month's largest daily total. */
export function heatLevel(value: number, peak: number): number {
  return value <= 0 || peak <= 0 ? 0 : Math.min(4, Math.ceil(value / peak * 4));
}
