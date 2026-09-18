import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { compactTokens, formatTokens, sourceNames, type ConsumptionReport, type Tokens } from '../shared/consumption';
import { dataAge } from '../shared/usage';
import { hasConsumptionReading } from '../shared/consumption-cache';
import { localizeHostLabel, localizeUsageMessage, ui } from './i18n';

type Theme = PluginHostProps['theme'];
function Metric({ label, value, theme }: { label: string; value: number | null; theme: Theme }) {
  return <View style={{ minWidth: '45%', flexGrow: 1, gap: 3 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
    <Text accessibilityLabel={`${label} ${value === null ? ui('Not provided', '未提供') : `${formatTokens(value)} token`}`} style={{ color: theme.colors.foreground, fontSize: 13, fontVariant: ['tabular-nums'] }}>{value === null ? ui('Not provided', '未提供') : formatTokens(value)}</Text>
  </View>;
}
export function Breakdown({ tokens, theme }: { tokens: Tokens; theme: Theme }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
    <Metric label={ui('Input (including cache)', '输入（含缓存）')} value={tokens.input} theme={theme} />
    <Metric label={ui('Output (including reasoning)', '输出（含推理）')} value={tokens.output} theme={theme} />
    <Metric label={ui('Cache read', '其中缓存读取')} value={tokens.cacheRead} theme={theme} />
    <Metric label={ui('Cache write', '其中缓存写入')} value={tokens.cacheWrite} theme={theme} />
    <Metric label={ui('Reasoning', '其中推理')} value={tokens.reasoning} theme={theme} />
  </View>;
}
export function ConsumptionSources({ report, theme }: { report?: ConsumptionReport; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);
  const sources = report?.sources ?? [];
  const issues = sources.filter(source => source.status === 'error' || source.status === 'partial');
  const loading = !report || report.scanning && !hasConsumptionReading(report);
  const hostIssues = report?.hosts?.filter(host => host.status === 'offline' || host.status === 'error') ?? [];
  return <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, gap: 4 }}>
    {report?.hosts?.map(host => <View key={host.id} style={{ paddingTop: 10, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }}>{localizeHostLabel(host.label)}</Text>
        <Text accessibilityLabel={ui(`${localizeHostLabel(host.label)} recorded usage ${host.total === null ? 'unknown' : `${formatTokens(host.total)} tokens`}`, `${localizeHostLabel(host.label)} 已记录消耗 ${host.total === null ? '未知' : `${formatTokens(host.total)} token`}`)} style={{ color: theme.colors.foreground, fontSize: 12 }}>{host.total === null ? '—' : compactTokens(host.total)}</Text>
      </View>
      <Text style={{ color: host.status === 'offline' || host.status === 'error' ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 11, lineHeight: 17 }}>{{ ready: ui('Read', '已读取'), loading: ui('Updating', '更新中'), offline: ui('Offline · Previous record', '未连接 · 上次记录'), error: ui('Read failed · Previous record', '读取失败 · 上次记录') }[host.status]} · {dataAge(host.updatedAt)}</Text>
    </View>)}
    {hostIssues.length ? <Text accessibilityRole="alert" style={{ fontSize: 11, lineHeight: 17, color: theme.colors.statusWarning }}>{ui('Some hosts are temporarily unavailable, so the current total may be incomplete.', '部分主机暂不可用，当前合计可能不完整。')}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel={ui('Data sources and calculation notes', '数据来源与统计说明')} aria-expanded={expanded} accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 44, opacity: pressed ? 0.65 : 1 })}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: '500' }}>{ui('Data Sources', '数据来源')}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: issues.length || hostIssues.length ? theme.colors.statusWarning : loading || !sources.length ? theme.colors.foregroundMuted : theme.colors.statusSuccess }} />
        <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>{loading ? ui('Loading', '读取中') : issues.length ? ui(`${issues.length} need attention`, `${issues.length} 项需关注`) : ui(`${sources.length} sources`, `${sources.length} 项来源`)}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{expanded ? '−' : '+'}</Text>
      </View>
    </Pressable>
    {!expanded && issues.length ? <Text accessibilityRole="alert" style={{ fontSize: 11, lineHeight: 17, color: theme.colors.statusWarning }}>{ui(`${issues.map(source => `${sourceNames[source.source]} ${source.status === 'error' ? 'read failed' : 'record incomplete'}`).join(', ')}. Click for details.`, `${issues.map(source => `${sourceNames[source.source]}${source.status === 'error' ? '读取失败' : '记录不完整'}`).join('、')}，点击查看详情。`)}</Text> : null}
    {report?.unsupportedProviders?.map(provider => <Text key={`${provider.host?.id ?? "local"}:${provider.id}`} style={{ fontSize: 11, lineHeight: 17, color: theme.colors.foregroundMuted }}>{provider.host ? `${localizeHostLabel(provider.host.label)} · ` : ''}{provider.label} · {ui('Usage tracking is not supported yet', '暂不支持消耗统计')}</Text>)}
    {expanded ? <View style={{ gap: 10, paddingTop: 8, paddingBottom: 4 }}>
      {sources.map(source => <View key={`${source.host?.id ?? "local"}:${source.source}`} style={{ gap: 4 }}>
        <Text style={{ fontSize: 11, color: source.status === 'error' || source.status === 'partial' ? theme.colors.statusWarning : theme.colors.foregroundMuted }}>{source.host ? `${localizeHostLabel(source.host.label)} · ` : ''}{sourceNames[source.source]} · {{ loading: ui('Loading', '读取中'), ready: ui('Read', '已读取'), empty: ui('No records in this period', '该时段无记录'), partial: ui('Record incomplete', '记录不完整'), error: ui('Read failed', '读取失败') }[source.status]}{source.updatedAt ? ` · ${dataAge(source.updatedAt)}` : ''}</Text>
        {source.message ? <Text style={{ fontSize: 11, lineHeight: 17, color: theme.colors.foregroundMuted }}>{localizeUsageMessage(source.message)}{source.status === 'error' && source.rows.length ? ui('; previous data retained', '；保留上次数据') : ''}</Text> : null}
      </View>)}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 18 }}>{ui(`Each host follows its own Providers toggles and counts retained records from enabled sources, including sessions run directly in a terminal. Deleted or unrecorded calls cannot be recovered; sources such as Grok may not be counted until a turn ends.${report?.hosts ? ' Cross-host totals add their records together; identical history copied to another host cannot currently be deduplicated across machines.' : ''}`, `各主机分别跟随本机 Providers 开关，统计已启用来源保留的记录，含终端直接运行的会话。已删除或未记录的调用无法补回；Grok 等来源可能在轮次结束后才计入。${report?.hosts ? '跨主机按记录相加；复制到其他主机的同一份历史暂不能跨机器去重。' : ''}`)}</Text>
    </View> : null}
  </View>;
}
