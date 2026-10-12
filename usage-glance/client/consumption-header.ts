import type { PluginButtonIcon, PluginButtonRegistration, PluginClientContext } from '@getpaseo/plugin/client';
import { compactTokens, formatTokens, presetRange, totalTokens, type ConsumptionReport } from '../shared/consumption';
import { consumptionTimezone, hasConsumptionReading } from '../shared/consumption-cache';
import type { HostRegistry } from './hosts';
import { combineHostConsumption } from './multi-host-consumption';
import { followWorkspaces } from './workspaces';
import { ui } from './i18n';

export function consumptionTone(total: number | null) {
  return total === null ? 'unknown' : total >= 5_000_000_000 ? 'danger' : total >= 1_000_000_000 ? 'warning' : 'success';
}

export function consumptionHeaderSummary(report: ConsumptionReport): { total: number | null; partial: boolean; tone: ReturnType<typeof consumptionTone> } {
  const total = hasConsumptionReading(report) ? report.sources.reduce((sum, source) => sum + source.rows.reduce((sum, row) => sum + totalTokens(row), 0), 0) : null;
  const partial = !!report.unsupportedProviders?.length || !!report.hosts?.some(host => host.status !== 'ready') || report.sources.some(source => ['partial', 'error', 'loading'].includes(source.status));
  return { total, partial, tone: consumptionTone(total) };
}

/** Uses the already-warmed fleet cache, so headers never start another scan. */
export function installConsumptionHeaders(client: PluginClientContext, registry: HostRegistry, icon: (tone: ReturnType<typeof consumptionTone>) => PluginButtonIcon, timezone = consumptionTimezone(), now = () => new Date()) {
  const headers = new Map<string, PluginButtonRegistration>();
  const summary = () => consumptionHeaderSummary(combineHostConsumption(registry.getSnapshot(), presetRange('today', timezone, now())));
  const button = () => {
    const { total, partial, tone } = summary();
    const range = presetRange('today', timezone, now());
    return {
      title: `${ui('Today’s token usage · All hosts', '今日 Token 消耗 · 全部主机')} · ${total === null ? ui('Waiting for records', '等待用量记录') : `${formatTokens(total)} tokens`}${partial ? ui(' · Partial records', ' · 部分记录') : ''} · ${range.since} · ${timezone}\n${ui('Green <1B · Yellow 1B–5B · Red ≥5B. Open usage details.', '绿色 <1B · 黄色 1B–5B · 红色 ≥5B。点击查看消耗明细。')}`,
      label: `${ui('Today', '今日')} ${total === null ? '—' : compactTokens(total)}${partial ? ' *' : ''}`,
      icon: icon(tone),
      behavior: { kind: 'action' as const, onPress: () => client.openSurface('consumption') },
    };
  };
  const update = () => { const next = button(); for (const header of headers.values()) header.update(next); };
  const unsubscribe = registry.subscribe(update);
  const stopWorkspaces = followWorkspaces(client.paseo, ids => {
    for (const [id, header] of headers) if (!ids.has(id)) { header.remove(); headers.delete(id); }
    for (const workspaceId of ids) if (!headers.has(workspaceId)) headers.set(workspaceId, client.addHeaderButton({ id: 'today-consumption', workspaceId, button: button() }));
  });
  // Recompute today's projection at midnight even if a host is offline.
  const timer = setInterval(update, 30000);
  return () => {
    clearInterval(timer); unsubscribe(); stopWorkspaces();
    for (const header of headers.values()) header.remove();
    headers.clear();
  };
}
