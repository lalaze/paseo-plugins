import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { compactTokens, dateInZone, formatTokens, sourceNames, totalTokens } from '../shared/consumption';
import { buildMonthHeatmap, heatLevel, monthRange, shiftMonth } from '../shared/heatmap';
import { dataAge } from '../shared/usage';
import { useConsumption, type ConsumptionQuery } from './consumption-query';
import { Breakdown, ConsumptionSources } from './consumption-details';
import { SmallStat, TextAction, TotalCard } from './consumption-ui';
import { hasConsumptionReading } from '../shared/consumption-cache';

const opacity = [0, 0.14, 0.28, 0.42, 1];
const modelOrigin = (model: { source: keyof typeof sourceNames; host?: { label: string } }) => `${model.host ? `${model.host.label} · ` : ''}${sourceNames[model.source]}`;
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
export function MonthlyHeatmap({ theme, layout, query, timezone }: Pick<PluginHostProps, 'theme' | 'layout'> & { query: ConsumptionQuery; timezone: string }) {
  const today = dateInZone(new Date(), timezone), currentMonth = today.slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [requestedModel, setRequestedModel] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  const [picker, setPicker] = useState(false), [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState(false);
  const range = monthRange(month, timezone), result = useConsumption(query, range), report = result.data;
  const sources = report?.sources ?? [];
  const all = buildMonthHeatmap(sources, month, today);
  const selectedModel = all.models.find(model => model.key === requestedModel);
  const heatmap = selectedModel ? buildMonthHeatmap(sources, month, today, selectedModel.key) : all;
  const relevant = selectedModel ? sources.filter(source => source.source === selectedModel.source && source.host?.id === selectedModel.host?.id) : sources;
  const relevantHosts = report?.hosts?.filter(host => !selectedModel?.host || host.id === selectedModel.host.id);
  const pending = result.isPending || (selectedModel && relevantHosts ? relevantHosts.some(host => host.status === 'loading') : report?.scanning === true && !hasConsumptionReading(report));
  const incomplete = pending || result.isError || refreshError || !!relevantHosts?.some(host => host.status !== 'ready') || relevant.some(source => source.status === 'error' || source.status === 'partial' || source.status === 'loading') || (!selectedModel && !!report?.unsupportedProviders?.length);
  const unknownTotal = heatmap.total === 0 && (incomplete || !sources.length);
  const latest = relevant.map(source => source.updatedAt).filter((date): date is string => date !== null).sort()[0];
  const activeDate = selectedDate?.startsWith(`${month}-`) ? selectedDate : month === currentMonth ? today : range.until;
  const day = heatmap.days.find(day => day.date === activeDate)!;
  const matches = all.models.filter(model => `${model.model} ${modelOrigin(model)}`.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => {
    if (report && !report.scanning && requestedModel && !selectedModel) setRequestedModel(null);
  }, [report, requestedModel, selectedModel]);
  const changeMonth = (next: string) => { setMonth(next); setSelectedDate(null); setRefreshError(false); setPicker(false); setSearch(''); };
  const selectModel = (key: string | null) => { setRequestedModel(key); setPicker(false); setSearch(''); };
  const refresh = async () => { setRefreshing(true); setRefreshError(false); try { await query.refresh(range); } catch { setRefreshError(true); } finally { setRefreshing(false); } };
  const button = { borderRadius: 10, paddingHorizontal: 8, minHeight: 44, justifyContent: 'center' as const, alignItems: 'center' as const };
  return <View style={{ width: '100%', gap: 14 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text accessibilityLabel={`热力图月份 ${month}`} style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{Number(month.slice(0, 4))} 年 {Number(month.slice(-2))} 月</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{pending ? '正在读取记录…' : dataAge(latest)}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 10, backgroundColor: theme.colors.surface0 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="上一月" disabled={month === '0000-01'} onPress={() => changeMonth(shiftMonth(month, -1))} style={{ ...button, minWidth: 44 }}><Text style={{ color: theme.colors.foreground, fontSize: 22 }}>‹</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="下一月" disabled={month >= currentMonth} onPress={() => changeMonth(shiftMonth(month, 1))} style={{ ...button, minWidth: 44, opacity: month >= currentMonth ? 0.3 : 1 }}><Text style={{ color: theme.colors.foreground, fontSize: 22 }}>›</Text></Pressable>
      </View>
      <TextAction label={pending || refreshing ? '更新中' : '刷新'} accessibilityLabel="刷新月度热力图" disabled={pending || refreshing} onPress={() => { void refresh(); }} theme={theme} />
    </View>
    <View style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="选择热力图模型" aria-expanded={picker} accessibilityState={{ expanded: picker }} onPress={() => setPicker(value => !value)} style={({ pressed }) => ({ ...button, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', justifyContent: 'space-between', gap: 8, backgroundColor: theme.colors.surface0, opacity: pressed ? 0.65 : 1 })}>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: '500' }}>{selectedModel?.model ?? '全部模型'}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{selectedModel ? modelOrigin(selectedModel) : `${all.models.length} 项模型来源 · 已启用的 Providers`}</Text>
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{picker ? '收起' : '切换'}</Text>
      </Pressable>
      {picker ? <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 8, gap: 6 }}>
        <TextInput accessibilityLabel="筛选热力图模型" value={search} onChangeText={setSearch} placeholder="搜索模型、Provider 或主机" placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" style={{ minHeight: 44, padding: 10, color: theme.colors.foreground, fontSize: 12, backgroundColor: theme.colors.surface0, borderRadius: 8 }} />
        <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          <Pressable accessibilityRole="button" accessibilityLabel="热力图选择全部模型" accessibilityState={{ selected: !selectedModel }} onPress={() => selectModel(null)} style={{ padding: 10, minHeight: 44, justifyContent: 'center', backgroundColor: !selectedModel ? theme.colors.surface2 : 'transparent', borderRadius: 8 }}><Text style={{ color: theme.colors.accent, fontSize: 12 }}>全部模型</Text></Pressable>
          {matches.map(model => <Pressable key={model.key} accessibilityRole="button" accessibilityLabel={`热力图选择 ${model.model} ${modelOrigin(model)}`} accessibilityState={{ selected: selectedModel?.key === model.key }} onPress={() => selectModel(model.key)} style={{ padding: 10, minHeight: 44, justifyContent: 'center', gap: 4, backgroundColor: selectedModel?.key === model.key ? theme.colors.surface2 : 'transparent', borderRadius: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}>{model.model}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{modelOrigin(model)} · {compactTokens(totalTokens(model))} token</Text>
          </Pressable>)}
          {!matches.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, padding: 10 }}>{pending ? '正在读取模型…' : search ? '没有匹配的模型' : '本月尚无已记录的模型消耗'}</Text> : null}
        </ScrollView>
      </View> : null}
    </View>
    {result.isError || refreshError ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning, fontSize: 12 }}>读取失败，请重试。{report ? '以下为上次读取的数据。' : ''}</Text> : null}
    <TotalCard label="本月消耗" total={unknownTotal ? null : heatmap.total} accessibilityLabel={unknownTotal ? '热力图月合计 暂无完整记录' : `热力图月合计 ${formatTokens(heatmap.total)} token`} partial={incomplete} theme={theme}>
      <SmallStat label="有记录天数" value={`${heatmap.activeDays} 天`} theme={theme} />
      <SmallStat label="单日峰值" value={unknownTotal ? '—' : compactTokens(heatmap.peak)} theme={theme} />
    </TotalCard>
    <View style={{ gap: 10, width: '100%' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 30 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: '600' }}>每日消耗</Text>
        {month !== currentMonth ? <TextAction label="回到本月" accessibilityLabel="回到本月" onPress={() => changeMonth(currentMonth)} theme={theme} /> : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>点击日期查看</Text>}
      </View>
      <View testID="monthly-heatmap" style={{ gap: 5 }}>
        <View style={{ flexDirection: 'row', gap: 5 }}>{weekdays.map(day => <View key={day} style={{ flex: 1, minWidth: 0, alignItems: 'center', paddingBottom: 5 }}><Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{day}</Text></View>)}</View>
        {heatmap.weeks.map((week, index) => <View key={index} style={{ flexDirection: 'row', gap: 5 }}>
          {week.map((cell, column) => {
            // Keep blank/date columns identical; borders must not affect flex widths.
            if (!cell) return <View key={`blank-${column}`} style={{ flex: 1, minWidth: 0 }} />;
            const value = totalTokens(cell), level = heatLevel(value, heatmap.peak), selected = cell.date === activeDate;
            const unknown = !cell.future && value === 0 && (incomplete || !sources.length);
            const ink = level === 4 ? theme.colors.accentForeground : cell.future ? theme.colors.foregroundMuted : theme.colors.foreground;
            return <View key={cell.date} style={{ flex: 1, minWidth: 0 }}><Pressable accessibilityRole="button" accessibilityLabel={`${cell.date} ${cell.future ? '未到来' : unknown ? '记录未完整' : `${formatTokens(value)} token`}`} accessibilityState={{ selected, disabled: cell.future }} disabled={cell.future} onPress={() => setSelectedDate(cell.date)} style={({ pressed }) => ({ width: '100%', height: layout.compact ? 44 : 56, borderRadius: 8, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: cell.future ? 'transparent' : level ? theme.colors.surface1 : theme.colors.surface0, opacity: pressed ? 0.7 : 1 })}>
              {level ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: theme.colors.accent, opacity: opacity[level] }} /> : null}
              <Text style={{ width: '100%', textAlign: 'center', color: ink, opacity: cell.future ? 0.4 : 1, fontSize: 12, lineHeight: 18, includeFontPadding: false, fontWeight: '500', fontVariant: ['tabular-nums'] }}>{cell.day}</Text>
              {unknown ? <Text style={{ position: 'absolute', bottom: 2, left: 0, right: 0, textAlign: 'center', color: theme.colors.foregroundMuted, fontSize: 8, lineHeight: 8, includeFontPadding: false }}>—</Text> : null}
              {selected ? <View pointerEvents="none" style={{ position: 'absolute', top: 5, right: 5, width: 4, height: 4, borderRadius: 2, backgroundColor: ink }} /> : null}
            </Pressable></View>;
          })}
        </View>)}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, flexShrink: 1 }}>{timezone}</Text>
        <View accessibilityLabel="颜色越深，当日消耗越多；按本月单日峰值分级" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>少</Text>
          {opacity.map((value, index) => <View key={index} style={{ width: 11, height: 11, borderRadius: 3, overflow: 'hidden', backgroundColor: theme.colors.surface0 }}><View style={{ flex: 1, backgroundColor: theme.colors.accent, opacity: value }} /></View>)}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>多</Text>
        </View>
      </View>
      {incomplete ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>「—」表示记录尚不完整</Text> : null}
    </View>
    <View accessibilityLiveRegion="polite" style={{ padding: 14, backgroundColor: theme.colors.surface0, borderRadius: 14, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text accessibilityLabel={`${activeDate} · 当日明细`} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: '600' }}>{Number(activeDate.slice(5, 7))} 月 {Number(activeDate.slice(-2))} 日</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>当日消耗</Text>
      </View>
      {totalTokens(day) > 0 ? <>
        <Text accessibilityLabel={`热力图当日合计 ${formatTokens(totalTokens(day))} token`} selectable style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{formatTokens(totalTokens(day))}<Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: '400' }}> token{incomplete ? ' · 已读取' : ''}</Text></Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <SmallStat label="输入 · 含缓存" value={compactTokens(day.input)} theme={theme} />
          <SmallStat label="输出 · 含推理" value={compactTokens(day.output)} theme={theme} />
        </View>
        {!selectedModel ? day.models.map(model => <View key={model.key} style={{ gap: 4, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 10 }}>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}>{model.model}{model.inferredModel ? ' · 模型推定' : ''}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{modelOrigin(model)} · {formatTokens(totalTokens(model))} token</Text>
        </View>) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="当日 token 明细" aria-expanded={detail} accessibilityState={{ expanded: detail }} onPress={() => setDetail(value => !value)} style={{ minHeight: 44, justifyContent: 'center', borderTopWidth: 1, borderTopColor: theme.colors.border }}><Text style={{ color: theme.colors.accent, fontSize: 12 }}>{detail ? '收起' : '查看'} token 明细 {detail ? '−' : '+'}</Text></Pressable>
        {detail ? <Breakdown tokens={day} theme={theme} /> : null}
      </> : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 19 }}>{pending ? '正在读取记录…' : relevantHosts?.some(host => host.status !== 'ready') ? '主机记录尚不完整，暂不能确认当天消耗。' : !sources.length ? '当前未启用支持消耗统计的 Provider。' : incomplete ? '记录不完整，暂不能确认当天消耗。' : '当天没有已记录的消耗。'}</Text>}
    </View>
    <ConsumptionSources report={report} theme={theme} />
  </View>;
}
