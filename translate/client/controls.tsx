import { Pressable, Text, View, type ViewStyle } from 'react-native';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import type { TargetLanguage } from '../shared/rpc';
import { targets } from './use-translation';
import { ui } from './i18n';

type Theme = PluginHostProps['theme'];

export function ActionButton({ theme, label, onPress, primary = false, disabled = false, color, style }: { theme: Theme; label: string; onPress(): void; primary?: boolean; disabled?: boolean; color?: string; style?: ViewStyle }) {
  const colors = theme.colors;
  return <Pressable
    accessibilityRole="button"
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => ({
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 9,
      borderWidth: primary ? 0 : 1,
      borderColor: colors.border,
      backgroundColor: primary ? colors.accent : colors.surface2,
      ...style,
      opacity: disabled ? 0.5 : pressed ? (primary ? 0.75 : 0.7) : 1,
    })}
  >
    <Text style={{ color: color ?? (primary ? colors.accentForeground : colors.foreground), fontWeight: primary ? '700' : '600' }}>{label}</Text>
  </Pressable>;
}

export function TargetPicker({ theme, value, onChange, disabled = false }: { theme: Theme; value: TargetLanguage; onChange(value: TargetLanguage): void; disabled?: boolean }) {
  const colors = theme.colors;
  return <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
    {targets.map(option => {
      const selected = value === option.value;
      return <Pressable
        key={option.value}
        accessibilityRole="radio"
        accessibilityState={{ checked: selected, disabled }}
        disabled={disabled}
        onPress={() => onChange(option.value)}
        style={({ pressed }) => ({ minHeight: 42, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: selected ? colors.accent : colors.border, borderRadius: 20, backgroundColor: selected ? colors.surface2 : colors.surface1, opacity: disabled ? 0.6 : pressed ? 0.7 : 1 })}
      >
        <Text style={{ color: selected ? colors.accent : colors.foreground, fontWeight: selected ? '700' : '500' }}>{ui(option.en, option.zh)}</Text>
      </Pressable>;
    })}
  </View>;
}
