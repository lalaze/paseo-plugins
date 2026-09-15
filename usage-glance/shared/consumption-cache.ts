import { presetRange, type ConsumptionRange, type ConsumptionReport } from './consumption';
import { monthRange } from './heatmap';

export function consumptionTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** One scan covers today, the last seven days, month-to-date and the monthly calendar. */
export function backgroundConsumptionRange(timezone: string, now = new Date()): ConsumptionRange {
  const week = presetRange('week', timezone, now), month = monthRange(week.until.slice(0, 7), timezone);
  return { ...month, since: week.since < month.since ? week.since : month.since };
}

export function coversConsumptionRange(outer: ConsumptionRange, inner: ConsumptionRange) {
  return outer.timezone === inner.timezone && outer.since <= inner.since && outer.until >= inner.until;
}

export function projectConsumptionReport(report: ConsumptionReport, range: ConsumptionRange): ConsumptionReport {
  if (!coversConsumptionRange(report.range, range)) throw new Error('缓存日期或时区不匹配');
  if (report.range.since === range.since && report.range.until === range.until) return report;
  return { ...report, range, sources: report.sources.map(source => {
    const rows = source.rows.filter(row => row.date >= range.since && row.date <= range.until);
    const status = source.status === 'ready' || source.status === 'empty' ? rows.length ? 'ready' : 'empty' : source.status;
    return { ...source, rows, status };
  }) };
}

export function hasConsumptionReading(report?: ConsumptionReport) {
  if (report?.hosts) return report.hosts.some(host => host.total !== null);
  return !!report && (report.sources.length === 0 ? !report.scanning : report.sources.some(source => source.updatedAt !== null || source.rows.length > 0 || source.status === 'ready' || source.status === 'empty'));
}
