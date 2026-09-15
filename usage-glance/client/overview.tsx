import type { PluginHostProps, PluginButtonIconProps } from '@getpaseo/plugin/client';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useEffect, useSyncExternalStore } from 'react';
import { balancePercent, balanceRemaining, dataAge, findUsage, formatBalance, formatPercent, hasQuota, headerSummary, isStale, providerShortName, remaining, resetLabel, summary, tone, type Tone, type Usage } from '../shared/usage';
import { useUsage, type UsageQuery } from './query';
import type { HeaderPreference } from './preference';

type Theme = PluginHostProps['theme'];
export const toneColor = (theme: Theme, status: Tone) => ({ ok: theme.colors.statusSuccess, warning: theme.colors.statusWarning, danger: theme.colors.statusDanger, unknown: theme.colors.foregroundMuted })[status];

function Meter({ label, value, text, resetsAt, theme }: { label: string; value: number | null; text?: string; resetsAt?: string | null; theme: Theme }) {
  const color = toneColor(theme, tone(value));
  const reset = resetLabel(resetsAt);
  const shortLabel = label.replace(/\bGemini Models\b/gi, 'Gemini')
    .replace(/\bClaude and GPT models\b/gi, 'Claude/GPT')
    .replace(/\bWeekly limit\b/gi, '每周')
    .replace(/\b5-hour limit\b/gi, '5 小时');
  return <View style={{ gap: 3 }}>
    <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 6, justifyContent: 'space-between' }}>
      <Text accessibilityLabel={label} style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17, flexShrink: 1 }}>{shortLabel}</Text>
      <Text style={{ color, fontSize: 13, lineHeight: 17, fontWeight: '600' }}>{text ?? (value === null ? '额度未知' : `剩余 ${formatPercent(value)}`)}</Text>
    </View>
    {value !== null || reset ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {value !== null ? <View accessibilityRole="progressbar" accessibilityLabel={`${label}剩余额度`} accessibilityValue={{ min: 0, max: 100, now: value, text: `剩余 ${formatPercent(value)}` }} style={{ flex: 1, minWidth: 40, height: 4, borderRadius: 2, overflow: 'hidden', backgroundColor: theme.colors.surface2 }}>
        <View style={{ height: 4, width: `${value}%`, borderRadius: 2, backgroundColor: color }} />
      </View> : null}
      {reset ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16, flexShrink: 1, width: value !== null ? '52%' : undefined, textAlign: value !== null ? 'right' : 'left' }}>{reset}</Text> : null}
    </View> : null}
  </View>;
}

function HeaderPicker({ providers, selected, onSelect, theme, compact }: { providers: Usage[]; selected: string | null; onSelect: (id: string | null) => void; theme: Theme; compact: boolean }) {
  const options: { id: string | null; label: string }[] = [{ id: null, label: '最低剩余' }];
  const seen = new Set<string>();
  for (const usage of providers) {
    if (!hasQuota(usage) || seen.has(usage.providerId)) continue;
    seen.add(usage.providerId);
    options.push({ id: usage.providerId, label: providerShortName(usage) });
  }
  return <View style={{ gap: 6 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>顶栏展示</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {options.map(option => {
        const active = option.id === selected;
        return <Pressable key={option.id ?? 'lowest'} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={`顶栏展示${option.label}`} onPress={() => onSelect(option.id)} style={{ borderWidth: 1, borderColor: active ? theme.colors.accent : theme.colors.border, backgroundColor: active ? theme.colors.surface2 : theme.colors.surface1, borderRadius: 7, minHeight: compact ? 44 : 28, justifyContent: 'center', paddingHorizontal: 10, paddingVertical: compact ? 10 : 5 }}>
          <Text style={{ color: active ? theme.colors.accent : theme.colors.foreground, fontSize: 12, fontWeight: active ? '600' : '400' }}>{option.label}</Text>
        </Pressable>;
      })}
    </View>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{selected ? '顶栏固定显示该供应商，不受其他额度变化影响' : '顶栏自动显示剩余最低的供应商'}</Text>
  </View>;
}

export function ProviderCard({ usage, theme, current, pinned }: { usage: Usage; theme: Theme; current: boolean; pinned: boolean }) {
  const brief = summary(usage);
  return <View style={{ borderWidth: 1, borderColor: current || pinned ? theme.colors.accent : theme.colors.border, borderRadius: 10, padding: 12, gap: 10, backgroundColor: theme.colors.surface1 }}>
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <View style={{ height: 7, width: 7, borderRadius: 4, backgroundColor: toneColor(theme, brief.tone) }} />
        <Text style={{ color: theme.colors.foreground, fontWeight: '600', fontSize: 14, lineHeight: 20, flexShrink: 1 }}>{usage.displayName}</Text>
        {current ? <Text style={{ color: theme.colors.accent, fontSize: 12 }}>当前会话</Text> : null}
        {pinned ? <Text style={{ color: theme.colors.accent, fontSize: 12 }}>顶栏</Text> : null}
      </View>
      {usage.planLabel ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{usage.planLabel}</Text> : null}
    </View>
    {usage.status !== 'available' ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>暂不可用 · 请检查该供应商的登录状态</Text> : <>
      {usage.windows.filter(window => remaining(window) !== null).map(window => <Meter key={window.id} label={window.label} value={remaining(window)} resetsAt={window.resetsAt} theme={theme} />)}
      {usage.balances?.filter(balance => balanceRemaining(balance) !== null).map(balance => <Meter key={balance.id} label={balance.label} value={balancePercent(balance)} text={`剩余 ${formatBalance(balance)}`} resetsAt={balance.resetsAt} theme={theme} />)}
      {usage.details?.map(detail => <Text key={detail.id} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{detail.label} · {detail.value}</Text>)}
    </>}
  </View>;
}

export function Overview({ theme, layout, query, preference, currentProvider, popover = false }: PluginHostProps & { query: UsageQuery; preference: HeaderPreference; currentProvider?: string; popover?: boolean }) {
  const result = useUsage(query);
  const selected = useSyncExternalStore(preference.subscribe, preference.get, preference.get);
  useEffect(() => { void preference.load(); }, [preference]);
  const providers = (result.data?.providers ?? []).filter(hasQuota);
  const current = currentProvider ? findUsage(providers, currentProvider) : undefined;
  const pinnedId = selected && providers.some(item => item.providerId === selected) ? selected : null;
  const visible = [...providers].sort((a, b) => Number(b === current) - Number(a === current));
  const stale = result.isError || isStale(result.data);
  const body = <View style={{ gap: popover ? 10 : 16, width: '100%', maxWidth: 780, alignSelf: 'center' }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ gap: 2, flexShrink: 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: popover ? 15 : 25, fontWeight: '700' }}>额度概览</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: popover ? 11 : 12 }}>{dataAge(result.data?.fetchedAt)} · 自动更新</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="刷新额度" disabled={result.isFetching} onPress={() => { void result.refetch(); }} style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 7, minHeight: layout.compact ? 44 : 30, justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 5, opacity: result.isFetching ? 0.55 : 1 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{result.isFetching ? '更新中…' : '刷新'}</Text>
      </Pressable>
    </View>
    {stale ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning, fontSize: 13 }}>{result.data ? '数据待更新，以下为上次读取的额度。' : '额度读取失败，请稍后重试。'}</Text> : null}
    {result.isPending ? <Text style={{ color: theme.colors.foregroundMuted, paddingVertical: 24 }}>正在读取额度…</Text> : null}
    {currentProvider && !current && result.data ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>当前会话的供应商尚无额度数据，可查看其他供应商。</Text> : null}
    {!result.isPending && !providers.length && !result.isError ? <Text style={{ color: theme.colors.foregroundMuted }}>尚未返回额度数据</Text> : null}
    {providers.length ? <HeaderPicker providers={providers} selected={pinnedId} onSelect={id => { void preference.save(id); }} theme={theme} compact={layout.compact} /> : null}
    <View style={{ flexDirection: popover || layout.compact ? 'column' : 'row', flexWrap: 'wrap', gap: popover ? 8 : 12 }}>
      {visible.map(usage => <View key={usage.providerId} style={{ width: !popover && !layout.compact ? '48%' : '100%' }}><ProviderCard usage={usage} theme={theme} current={usage === current} pinned={usage.providerId === pinnedId} /></View>)}
    </View>
  </View>;
  // Paseo owns scrolling and spacing inside popovers / mobile sheets.
  return popover ? body : <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 28 }}>{body}</ScrollView>;
}

export function HeaderQuotaIcon(props: PluginButtonIconProps & { query: UsageQuery; preference: HeaderPreference }) {
  const result = useUsage(props.query);
  const selected = useSyncExternalStore(props.preference.subscribe, props.preference.get, props.preference.get);
  const status = result.isError || isStale(result.data) ? 'unknown' : headerSummary(result.data?.providers ?? [], selected).tone;
  return <View style={{ width: props.size, height: props.size, justifyContent: 'center', alignItems: 'center' }}>
    <View style={{ width: Math.max(6, props.size - 6), height: Math.max(6, props.size - 6), borderRadius: props.size, backgroundColor: toneColor(props.theme, status) }} />
  </View>;
}
