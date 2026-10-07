import type { ReactNode } from 'react';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Pressable, Text, TextInput, View } from 'react-native';

export type Colors = PluginSurfaceProps['theme']['colors'];

export function Button(props: { label: string; icon?: string; onPress(): void; colors: Colors; variant?: 'primary' | 'outline' | 'ghost' | 'danger'; disabled?: boolean }) {
  const { colors } = props;
  const variant = props.variant ?? 'outline';
  const fg = variant === 'primary' ? colors.accentForeground : variant === 'danger' ? colors.statusDanger : colors.foreground;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={props.label}
    disabled={props.disabled}
    onPress={props.onPress}
    style={({ pressed }) => ({
      flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: 999,
      backgroundColor: variant === 'primary' ? colors.accent : pressed ? colors.surface2 : 'transparent',
      borderWidth: variant === 'outline' || variant === 'danger' ? 1 : 0, borderColor: variant === 'danger' ? colors.statusDanger : colors.border,
      opacity: props.disabled ? 0.45 : pressed ? 0.85 : 1,
    })}
  >
    {props.icon ? <Icon name={props.icon} size={13} color={fg} /> : null}
    <Text style={{ color: fg, fontSize: 12, fontWeight: '600' }}>{props.label}</Text>
  </Pressable>;
}

/** A labelled on/off pill; stays readable where a native switch would need its own label. */
export function Toggle(props: { label: string; value: boolean; onChange(value: boolean): void; colors: Colors; disabled?: boolean }) {
  const { colors, value } = props;
  return <Pressable
    accessibilityRole="switch"
    accessibilityState={{ checked: value, disabled: props.disabled }}
    accessibilityLabel={props.label}
    disabled={props.disabled}
    onPress={() => props.onChange(!value)}
    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 26, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1,
      borderColor: value ? colors.accent : colors.border, backgroundColor: value ? colors.accent : 'transparent', opacity: props.disabled ? 0.45 : 1 }}
  >
    <Icon name={value ? 'Check' : 'Minus'} size={12} color={value ? colors.accentForeground : colors.foregroundMuted} />
    <Text style={{ color: value ? colors.accentForeground : colors.foregroundMuted, fontSize: 12, fontWeight: '600' }}>{props.label}</Text>
  </Pressable>;
}

export function Chip(props: { label: string; colors: Colors; tone?: 'muted' | 'success' | 'warning' | 'danger'; selected?: boolean; onPress?(): void }) {
  const { colors } = props;
  const tone = props.tone ?? 'muted';
  const fg = props.selected ? colors.accentForeground
    : tone === 'success' ? colors.statusSuccess : tone === 'warning' ? colors.statusWarning : tone === 'danger' ? colors.statusDanger : colors.foregroundMuted;
  const body = <Text style={{ color: fg, fontSize: 11, fontWeight: '600' }}>{props.label}</Text>;
  const style = { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: props.selected ? colors.accent : colors.surface2 };
  return props.onPress
    ? <Pressable accessibilityRole="button" accessibilityLabel={props.label} onPress={props.onPress} style={style}>{body}</Pressable>
    : <View style={style}>{body}</View>;
}

export function Section(props: { title: string; hint: string; colors: Colors; actions?: ReactNode; children: ReactNode }) {
  const { colors } = props;
  return <View style={{ gap: 10 }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
      <View style={{ flex: 1, minWidth: 220, gap: 2 }}>
        <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: '700' }}>{props.title}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{props.hint}</Text>
      </View>
      {props.actions ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{props.actions}</View> : null}
    </View>
    {props.children}
  </View>;
}

export function Card(props: { colors: Colors; children: ReactNode }) {
  return <View style={{ borderWidth: 1, borderColor: props.colors.border, borderRadius: 12, padding: 12, gap: 8, backgroundColor: props.colors.surface1 }}>{props.children}</View>;
}

export function Field(props: { label: string; value: string; onChange(value: string): void; colors: Colors; placeholder?: string; multiline?: boolean; mono?: boolean }) {
  const { colors } = props;
  return <View style={{ gap: 4 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' }}>{props.label}</Text>
    <TextInput
      value={props.value}
      onChangeText={props.onChange}
      placeholder={props.placeholder}
      placeholderTextColor={colors.foregroundMuted}
      multiline={props.multiline}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        minHeight: props.multiline ? 72 : 32, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.border,
        color: colors.foreground, fontSize: 12, textAlignVertical: props.multiline ? 'top' : 'center',
        fontFamily: props.mono ? 'monospace' : undefined, outlineStyle: 'solid', outlineWidth: 0,
      }}
    />
  </View>;
}

export function Muted(props: { colors: Colors; children: ReactNode; danger?: boolean; selectable?: boolean }) {
  return <Text selectable={props.selectable} style={{ color: props.danger ? props.colors.statusDanger : props.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{props.children}</Text>;
}
