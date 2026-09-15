import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { compactTokens, formatTokens } from '../shared/consumption';

export type Theme = PluginHostProps['theme'];

export function Segments({ options, theme, quiet = false }: { options: { label: string; active: boolean; onPress: () => void }[]; theme: Theme; quiet?: boolean }) {
  return <View style={{ flexDirection: 'row', padding: 3, gap: 2, borderRadius: 12, backgroundColor: quiet ? theme.colors.surface1 : theme.colors.surface0 }}>
    {options.map(option => <Pressable key={option.label} accessibilityRole="button" accessibilityState={{ selected: option.active }} onPress={option.onPress} style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: option.active ? quiet ? theme.colors.surface2 : theme.colors.surface1 : 'transparent', opacity: pressed ? 0.65 : 1 })}>
      <Text numberOfLines={1} style={{ color: option.active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 12, fontWeight: option.active ? '600' : '400' }}>{option.label}</Text>
    </Pressable>)}
  </View>;
}

export function TextAction({ label, accessibilityLabel, onPress, disabled, theme }: { label: string; accessibilityLabel: string; onPress: () => void; disabled?: boolean; theme: Theme }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : pressed ? 0.65 : 1 })}>
    <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: '500' }}>{label}</Text>
  </Pressable>;
}

export function TotalCard({ label, total, accessibilityLabel, partial, theme, children }: { label: string; total: number | null; accessibilityLabel: string; partial?: boolean; theme: Theme; children: ReactNode }) {
  return <View style={{ padding: 14, borderRadius: 16, backgroundColor: theme.colors.surface0, overflow: 'hidden', gap: 12 }}>
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: theme.colors.accent, opacity: 0.045 }} />
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
        {partial ? <Text style={{ color: theme.colors.statusWarning, fontSize: 10, fontWeight: '500' }}>部分记录</Text> : null}
      </View>
      <Text accessibilityLabel={accessibilityLabel} numberOfLines={1} adjustsFontSizeToFit style={{ color: theme.colors.foreground, fontSize: 36, lineHeight: 44, fontWeight: '700', letterSpacing: -1, fontVariant: ['tabular-nums'] }}>{total === null ? '—' : compactTokens(total)}<Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: '400', letterSpacing: 0 }}>  token</Text></Text>
      <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ['tabular-nums'] }}>{total === null ? '等待完整记录' : `${formatTokens(total)} tokens`}</Text>
    </View>
    <View style={{ flexDirection: 'row', gap: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border }}>{children}</View>
  </View>;
}

export function SmallStat({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
    <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{value}</Text>
  </View>;
}
