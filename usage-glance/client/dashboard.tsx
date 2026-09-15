import { useState } from 'react';
import { Pressable, View, Text } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { Overview } from './overview';
import { Consumption } from './consumption';
import type { ConsumptionQuery } from './consumption-query';
import type { UsageQuery } from './query';
import type { HeaderPreference } from './preference';

export function UsageDashboard(props: PluginHostProps & { query: UsageQuery; consumption: ConsumptionQuery; preference: HeaderPreference }) {
  const [tab, setTab] = useState<'quota' | 'consumption'>('quota');
  return <View style={{ width: '100%', gap: 12 }}>
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: props.theme.colors.border }}>
      {([['quota', '额度'], ['consumption', '消耗']] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} onPress={() => setTab(value)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: props.layout.compact ? 44 : 36, borderBottomWidth: 2, borderBottomColor: tab === value ? props.theme.colors.accent : 'transparent' }}>
        <Text style={{ color: tab === value ? props.theme.colors.accent : props.theme.colors.foregroundMuted, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      </Pressable>)}
    </View>
    {tab === 'quota' ? <Overview {...props} popover /> : <Consumption theme={props.theme} layout={props.layout} query={props.consumption} />}
  </View>;
}
