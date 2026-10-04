import { useState } from 'react';
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

export function TargetPicker({ theme, value, onChange, disabled = false, compact = false }: { theme: Theme; value: TargetLanguage; onChange(value: TargetLanguage): void; disabled?: boolean; compact?: boolean }) {
  const colors = theme.colors;
  const [expanded, setExpanded] = useState(false);
  const options = compact && !expanded ? targets.filter(option => ['auto', 'zh-CN', 'en', value].includes(option.value)) : targets;
  return <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
    {options.map(option => {
      const selected = value === option.value;
      return <Pressable
        key={option.value}
        accessibilityRole="radio"
        accessibilityState={{ checked: selected, disabled }}
        disabled={disabled}
        onPress={() => onChange(option.value)}
        style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: selected ? colors.accent : colors.border, borderRadius: 20, backgroundColor: selected ? colors.surface2 : colors.surface1, opacity: disabled ? 0.6 : pressed ? 0.7 : 1 })}
      >
        <Text style={{ color: selected ? colors.accent : colors.foreground, fontWeight: selected ? '700' : '500' }}>{ui(option.en, option.zh)}</Text>
      </Pressable>;
    })}
    {compact ? <Pressable accessibilityRole="button" accessibilityState={{ expanded, disabled }} disabled={disabled} onPress={() => setExpanded(value => !value)}
      style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, opacity: disabled ? 0.6 : pressed ? 0.7 : 1 })}>
      <Text style={{ color: colors.foregroundMuted }}>{expanded ? ui('Fewer', '收起') : ui('More', '更多')}</Text>
    </Pressable> : null}
  </View>;
}

export function TranslationProgress({ theme, progress, busy }: { theme: Theme; progress: { completed: number; total: number } | null; busy: boolean }) {
  if (!progress || progress.total <= 1) return null;
  const label = busy
    ? ui(`Translating · ${progress.completed}/${progress.total} parts`, `翻译中 · ${progress.completed}/${progress.total} 段`)
    : progress.completed < progress.total
      ? ui(`Translated ${progress.completed}/${progress.total} parts. Retry to continue.`, `已翻译 ${progress.completed}/${progress.total} 段，重试可继续。`)
      : ui(`All ${progress.total} parts translated`, `${progress.total} 段已全部翻译`);
  return <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: progress.total, now: progress.completed, text: label }} style={{ gap: 6 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
    <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: 'hidden' }}>
      <View style={{ height: 3, width: `${progress.completed / progress.total * 100}%`, backgroundColor: theme.colors.accent }} />
    </View>
  </View>;
}
