import { rangeSchema, sourceIds, type ConsumptionRange, type ConsumptionReport, type SourceId, type SourceReport } from '../shared/consumption';
import { runCcusage } from './ccusage';
import { runAntigravity } from './antigravity';
import { coversConsumptionRange, projectConsumptionReport } from '../shared/consumption-cache';

type ReadSource = (source: SourceId, range: ConsumptionRange, signal: AbortSignal) => Promise<{ rows: SourceReport['rows']; message: string | null }>;
type CacheEntry = { report: ConsumptionReport; startedAt: number; completedAt: number; controller: AbortController };
export class ConsumptionService {
  private cache = new Map<string, CacheEntry>();
  private active = 0;
  private waiters: (() => void)[] = [];
  private closed = false;
  private selection = '';
  constructor(private read: ReadSource = (source, range, signal) => source === 'antigravity' ? runAntigravity(range, signal) : runCcusage(source, range, signal), private now = Date.now) {}

  get(input: ConsumptionRange, selected: readonly SourceId[], refresh = false): ConsumptionReport {
    if (this.closed) throw new Error('用量服务已关闭');
    const sources = sourceIds.filter(source => selected.includes(source)), selection = sources.join(',');
    if (selection !== this.selection) {
      // Stop old reads and drop cached totals when the host's Provider switches change.
      for (const value of this.cache.values()) value.controller.abort();
      this.cache.clear(); this.selection = selection;
    }
    const range = rangeSchema.parse(input), now = this.now();
    const covering = [...this.cache].reverse().find(([, value]) => coversConsumptionRange(value.report.range, range));
    const key = covering?.[0] ?? JSON.stringify(range);
    let entry = covering?.[1];
    if (entry) { this.cache.delete(key); this.cache.set(key, entry); }
    if (!entry) {
      // A wider scan replaces smaller caches, avoiding repeated scans of the same logs.
      for (const [existingKey, value] of this.cache) if (coversConsumptionRange(range, value.report.range)) {
        value.controller.abort(); this.cache.delete(existingKey);
      }
      if (this.cache.size >= 8) {
        const victim = [...this.cache].find(([, value]) => !value.report.scanning);
        if (!victim) throw new Error('正在读取其他时间范围，请稍后重试');
        this.cache.delete(victim[0]);
      }
      entry = { report: { range, scanning: false, sources: sources.map(source => ({ source, status: 'loading', updatedAt: null, rows: [], message: null })) }, startedAt: 0, completedAt: 0, controller: new AbortController() };
      this.cache.set(key, entry);
    }
    if (sources.length && !entry.report.scanning && (!entry.completedAt || now - entry.completedAt >= 60000 || (refresh && now - entry.startedAt >= 5000))) void this.scan(entry);
    // Copy the envelope: background updates should only become visible on the next RPC.
    return projectConsumptionReport({ ...entry.report, sources: [...entry.report.sources] }, range);
  }
  private async acquire(signal: AbortSignal): Promise<void> {
    if (this.active < 2) { this.active++; return; }
    await new Promise<void>(resolve => this.waiters.push(resolve));
    if (signal.aborted) { this.release(); throw new Error('读取已取消'); }
  }
  private release() { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  private async scan(entry: CacheEntry) {
    entry.report.scanning = true; entry.startedAt = this.now();
    await Promise.all(entry.report.sources.map(async (old, index) => {
      const source = old.source, signal = entry.controller.signal;
      let acquired = false;
      try {
        await this.acquire(signal); acquired = true; if (signal.aborted) throw new Error('读取已取消');
        const result = await this.read(source, entry.report.range, signal);
        if (signal.aborted) return;
        entry.report.sources[index] = { source, rows: result.rows, updatedAt: new Date(this.now()).toISOString(), status: result.message ? 'partial' : result.rows.length ? 'ready' : 'empty', message: result.message };
      } catch (error) {
        if (!signal.aborted) entry.report.sources[index] = { ...old, source, status: 'error', message: error instanceof Error && /^(用量记录|采集器|模型|本机|读取超时|Antigravity)/.test(error.message) ? error.message : '本机记录暂时无法读取，请稍后重试' };
      } finally { if (acquired) this.release(); }
    }));
    entry.completedAt = this.now(); entry.report.scanning = false;
  }
  dispose() { this.closed = true; for (const value of this.cache.values()) value.controller.abort(); this.cache.clear(); }
}
