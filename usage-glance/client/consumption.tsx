import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { addTokens, compactTokens, emptyTokens, formatTokens, groupConsumption, presetRange, rangeSchema, sourceNames, totalTokens, type ConsumptionGroup, type ConsumptionGrouping, type ConsumptionRange } from '../shared/consumption';
import { dataAge } from '../shared/usage';
import { useConsumption, type ConsumptionQuery } from './consumption-query';
import { Breakdown, ConsumptionSources } from './consumption-details';
import { MonthlyHeatmap } from './monthly-heatmap';
import { Segments, SmallStat, TextAction, TotalCard } from './consumption-ui';
import { consumptionTimezone, hasConsumptionReading } from '../shared/consumption-cache';

type Theme = PluginHostProps['theme'];
function GroupCard({ group, total, theme, compact, byModel }: { group: ConsumptionGroup; total: number; theme: Theme; compact: boolean; byModel: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const value = totalTokens(group), share = total > 0 ? value / total * 100 : 0;
  return <View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? '收起' : '展开'}${group.label}${byModel ? '来源' : '模型'}明细`} aria-expanded={expanded} accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={({ pressed }) => ({ paddingVertical: 12, paddingHorizontal: 2, gap: 8, minHeight: compact ? 64 : 60, opacity: pressed ? 0.65 : 1 })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: '600', fontSize: 14, flexShrink: 1 }}>{group.label}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{compactTokens(value)}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>{expanded ? '−' : '+'}</Text>
        </View>
      </View>
      {group.detail ? <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{group.detail}</Text> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: 'hidden' }}>
          <View style={{ height: '100%', width: `${share}%`, backgroundColor: theme.colors.accent, borderRadius: 3 }} />
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, minWidth: 42, textAlign: 'right', fontVariant: ['tabular-nums'] }}>{share > 0 && share < 0.1 ? '< 0.1' : share.toFixed(1)}%</Text>
      </View>
    </Pressable>
    {expanded ? <View style={{ padding: 12, marginBottom: 8, borderRadius: 12, backgroundColor: theme.colors.surface0, gap: 14 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{group.models.length} 项{byModel ? '' : '模型'}来源</Text>
      <Breakdown tokens={group} theme={theme} />
      {group.models.map(model => <View key={`${model.host?.id ?? "local"}:${model.source}:${model.model}`} style={{ paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border, gap: 5 }}>
        <Text selectable style={{ color: theme.colors.foreground, fontWeight: '500', fontSize: 12, lineHeight: 18, flexShrink: 1 }}>{byModel ? `${model.host ? `${model.host.label} · ` : ''}${sourceNames[model.source]}` : model.model}{model.inferredModel ? ' · 模型推定' : ''}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{byModel ? '' : `${model.host ? `${model.host.label} · ` : ''}${sourceNames[model.source]} · `}共 {formatTokens(totalTokens(model))} token</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 18 }}>输入 {formatTokens(model.input)} · 输出 {formatTokens(model.output)}{model.cacheRead ? ` · 缓存读取 ${formatTokens(model.cacheRead)}` : ''}{model.cacheWrite ? ` · 缓存写入 ${formatTokens(model.cacheWrite)}` : ''}{model.reasoning !== null ? ` · 推理 ${formatTokens(model.reasoning)}` : ''}</Text>
      </View>)}
    </View> : null}
  </View>;
}

type ConsumptionProps = Pick<PluginHostProps, 'theme' | 'layout'> & { query: ConsumptionQuery; workspaceQuery?: ConsumptionQuery; scopeLabel?: string };
export function Consumption(props: ConsumptionProps) {
  const [timezone] = useState(consumptionTimezone);
  const [view, setView] = useState<'summary' | 'heatmap'>('summary');
  return <View style={{ gap: 16, width: '100%' }}>
    <Segments theme={props.theme} options={[
      { label: '消耗汇总', active: view === 'summary', onPress: () => setView('summary') },
      { label: '月度热力图', active: view === 'heatmap', onPress: () => setView('heatmap') },
    ]} />
    {view === 'summary' ? <ConsumptionSummary {...props} timezone={timezone} /> : <MonthlyHeatmap {...props} timezone={timezone} />}
  </View>;
}
function ConsumptionSummary({ theme, layout, query, workspaceQuery, timezone, scopeLabel }: ConsumptionProps & { timezone: string }) {
  const [preset, setPreset] = useState<'today' | 'week' | 'month' | 'custom'>('today');
  const [custom, setCustom] = useState(() => presetRange('month', timezone));
  const [draft, setDraft] = useState(custom);
  const [by, setBy] = useState<ConsumptionGrouping>('source');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const range: ConsumptionRange = preset === 'custom' ? custom : presetRange(preset, timezone);
  const validation = rangeSchema.safeParse(draft);
  const activeQuery = by === 'workspace' && workspaceQuery ? workspaceQuery : query;
  const result = useConsumption(activeQuery, range);
  const report = result.data, sources = report?.sources ?? [];
  const groups = groupConsumption(sources, by), totals = emptyTokens();
  for (const group of groups) addTokens(totals, group);
  const pending = result.isPending || (report?.scanning === true && !hasConsumptionReading(report));
  const incomplete = !!report?.unsupportedProviders?.length || report?.hosts?.some(host => host.status !== 'ready') || sources.some(source => ['partial', 'error', 'loading'].includes(source.status));
  const latest = sources.map(source => source.updatedAt).filter((date): date is string => date !== null).sort()[0];
  const refresh = async () => { setRefreshing(true); setRefreshError(false); try { await activeQuery.refresh(range); } catch { setRefreshError(true); } finally { setRefreshing(false); } };
  return <View style={{ gap: 14, width: '100%' }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <View style={{ gap: 4, flexShrink: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: '700' }}>{scopeLabel ?? '本机消耗'}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{pending ? '正在读取用量记录…' : `${dataAge(latest)} · 自动更新`}</Text>
      </View>
      <TextAction label={pending || refreshing ? '更新中' : '刷新'} accessibilityLabel="刷新消耗" disabled={pending || refreshing} onPress={() => { void refresh(); }} theme={theme} />
    </View>
    <Segments quiet theme={theme} options={([['today', '今日'], ['week', '近 7 天'], ['month', '本月'], ['custom', '自定义']] as const).map(([value, label]) => ({ label, active: preset === value, onPress: () => setPreset(value) }))} />
    {preset === 'custom' ? <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['since', 'until'] as const).map(key => <View key={key} style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{key === 'since' ? '开始日期' : '结束日期'}</Text>
          <TextInput accessibilityLabel={key === 'since' ? '消耗开始日期' : '消耗结束日期'} value={draft[key]} onChangeText={value => setDraft(previous => ({ ...previous, [key]: value }))} placeholder="YYYY-MM-DD" placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" maxLength={10} style={{ color: theme.colors.foreground, borderWidth: 1, borderColor: theme.colors.border, padding: 9, borderRadius: 6, minHeight: 44, fontSize: 12 }} />
        </View>)}
      </View>
      {!validation.success ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{validation.error.issues[0].message}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="应用消耗日期" disabled={!validation.success} onPress={() => { if (validation.success) setCustom(validation.data); }} style={{ minHeight: layout.compact ? 44 : 36, padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2, alignItems: 'center', justifyContent: 'center', opacity: validation.success ? 1 : 0.5 }}><Text style={{ color: theme.colors.accent, fontSize: 12 }}>应用日期</Text></Pressable>
    </View> : null}
    {result.isError || refreshError ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning, fontSize: 12 }}>读取失败，请重试。{report ? '以下为上次读取的数据。' : ''}</Text> : null}
    {groups.length ? <TotalCard label="已记录消耗" total={totalTokens(totals)} accessibilityLabel={`已记录消耗 ${formatTokens(totalTokens(totals))} token`} partial={incomplete || pending} theme={theme}>
      <SmallStat label="输入 · 含缓存" value={compactTokens(totals.input)} theme={theme} />
      <SmallStat label="输出 · 含推理" value={compactTokens(totals.output)} theme={theme} />
    </TotalCard> : <View style={{ padding: 16, borderRadius: 16, backgroundColor: theme.colors.surface0, gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: '600' }}>{pending ? '正在读取消耗' : '暂无消耗记录'}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 19 }}>{pending ? '正在整理已启用来源的记录…' : report ? report.hosts?.some(host => host.status !== 'ready') ? '所选主机暂未返回记录，请查看下方主机状态。' : !sources.length ? '当前未启用支持消耗统计的 Provider。' : incomplete ? '尚无可显示的消耗，请查看下方数据来源状态。' : '该时间范围没有已记录的消耗。' : '暂时无法读取，请稍后刷新。'}</Text>
    </View>}
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, textAlign: 'center' }}>{range.since === range.until ? range.since : `${range.since} — ${range.until}`} · {timezone}</Text>
    <View style={{ gap: 2 }}>
      <Segments quiet wrap={layout.compact} theme={theme} options={[
        { label: '按 Provider', active: by === 'source', onPress: () => setBy('source') },
        ...(workspaceQuery ? [{ label: '按 Workspace', active: by === 'workspace', onPress: () => setBy('workspace') }] : []),
        { label: '按模型', active: by === 'model', onPress: () => setBy('model') },
        { label: '按模型厂商', active: by === 'vendor', onPress: () => setBy('vendor') },
        ...(report?.hosts ? [{ label: '按主机', active: by === 'host', onPress: () => setBy('host') }] : []),
      ]} />
      {by === 'vendor' ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 17, paddingTop: 8 }}>按模型识别厂商，实际调用渠道可能不同</Text> : null}
      {by === 'model' ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 17, paddingTop: 8 }}>同名模型合并统计，展开查看各主机和 Provider 的消耗</Text> : null}
      {by === 'workspace' ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 17, paddingTop: 8 }}>按左侧工作区归类，包含 Working 和 Done。无法匹配、已移除或归属不明确的记录保留在「未归属 Workspace」。</Text> : null}
      {groups.map(group => <GroupCard key={`${by}:${group.id}`} group={group} total={totalTokens(totals)} theme={theme} compact={layout.compact} byModel={by === 'model'} />)}
    </View>
    <ConsumptionSources report={report} theme={theme} />
  </View>;
}
