import { Pressable, Text, View } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';

export function DashboardTabs({ tab, onSelect, theme, layout }: Pick<PluginHostProps, 'theme' | 'layout'> & { tab: 'quota' | 'consumption'; onSelect: (tab: 'quota' | 'consumption') => void }) {
  return <View accessibilityRole="tablist" style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
    {([['quota', '额度'], ['consumption', '消耗']] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="tab" aria-selected={tab === value} accessibilityState={{ selected: tab === value }} onPress={() => onSelect(value)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: layout.compact ? 44 : 36, borderBottomWidth: 2, borderBottomColor: tab === value ? theme.colors.accent : 'transparent' }}>
      <Text style={{ color: tab === value ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>)}
  </View>;
}
