import { View } from 'react-native';
import type { PluginButtonIconProps } from '@getpaseo/plugin/client';
import type { consumptionTone } from './consumption-header';

export function ConsumptionHeaderIcon({ size, theme, tone }: PluginButtonIconProps & { tone: ReturnType<typeof consumptionTone> }) {
  const color = tone === 'unknown' ? theme.colors.foregroundMuted : tone === 'success' ? theme.colors.statusSuccess : tone === 'warning' ? theme.colors.statusWarning : theme.colors.statusDanger;
  return <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
  </View>;
}
