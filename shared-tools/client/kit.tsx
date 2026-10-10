import { Children, isValidElement, useEffect, useRef, type ReactNode } from 'react';
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Animated, Easing, Platform, Pressable, Text, TextInput, View } from 'react-native';

export type Colors = PluginSurfaceProps['theme']['colors'];

export const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** `#rrggbb` plus an alpha byte. Host colors are hex; anything else is returned as is rather than guessed at. */
export function tint(color: string, alpha: number): string {
  const matched = /^#([0-9a-f]{6})$/i.exec(color);
  if (!matched) return color;
  return `#${matched[1]}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

/** Box and divider line: the plain border token nearly vanishes on the dark canvas. */
export function outline(colors: Colors): string {
  return tint(colors.foreground, 0.1);
}

type Tone = 'muted' | 'success' | 'warning' | 'danger';

function toneColor(colors: Colors, tone: Tone): string {
  return tone === 'success' ? colors.statusSuccess : tone === 'warning' ? colors.statusWarning : tone === 'danger' ? colors.statusDanger : colors.foregroundMuted;
}

/**
 * Primary is filled, outline is a border, ghost is text. `iconOnly` keeps the label for accessibility.
 * `blocked` swallows the press without dimming: a page-wide busy flag must not fade every control, which reads as a flash.
 */
export function Button(props: {
  label: string;
  icon?: string;
  onPress(): void;
  colors: Colors;
  variant?: 'primary' | 'outline' | 'ghost' | 'danger';
  disabled?: boolean;
  blocked?: boolean;
  iconOnly?: boolean;
  active?: boolean;
}) {
  const { colors } = props;
  const variant = props.variant ?? 'outline';
  const fg = variant === 'primary' ? colors.surface0 : variant === 'danger' ? colors.statusDanger : variant === 'ghost' && !props.active ? colors.foregroundMuted : colors.foreground;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={props.label}
    disabled={props.disabled || props.blocked}
    onPress={props.onPress}
    hitSlop={4}
    style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, flexShrink: 0,
      height: 28, width: props.iconOnly ? 28 : undefined, paddingHorizontal: props.iconOnly ? 0 : 10, borderRadius: 8,
      backgroundColor: variant === 'primary' ? colors.foreground
        : props.active || pressed || hovered ? tint(colors.foreground, 0.08) : 'transparent',
      borderWidth: variant === 'outline' || variant === 'danger' ? 1 : 0,
      borderColor: variant === 'danger' ? tint(colors.statusDanger, 0.5) : outline(colors),
      opacity: props.disabled ? 0.4 : pressed && variant === 'primary' ? 0.85 : 1,
    })}
  >
    {props.icon ? <Icon name={props.icon} size={14} color={fg} /> : null}
    {props.iconOnly && props.icon ? null : <Text style={{ color: fg, fontSize: 12, fontWeight: '600' }}>{props.label}</Text>}
  </Pressable>;
}

/** Track 34 wide with a 2px inset, thumb 16: the thumb slides 14 across. */
const TRACK_W = 34;
const TRACK_H = 20;
const INSET = 2;
const THUMB = 16;
const TRAVEL = TRACK_W - THUMB - INSET * 2;

/** `blocked` swallows the press without dimming, so a page-wide busy flag never flashes every switch. */
export function Switch(props: { label: string; value: boolean; onChange(value: boolean): void; colors: Colors; disabled?: boolean; blocked?: boolean }) {
  const { colors, value } = props;
  // Off and on tracks are stacked and crossfaded, and the thumb slides: only opacity and transform
  // animate, which behaves the same on the app and on the web.
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(progress, { toValue: value ? 1 : 0, duration: 170, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [progress, value]);
  const travel = progress.interpolate({ inputRange: [0, 1], outputRange: [0, TRAVEL] });
  const fill = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0, borderRadius: 999 };
  return <Pressable
    accessibilityRole="switch"
    accessibilityLabel={props.label}
    accessibilityState={{ checked: value, disabled: props.disabled || props.blocked }}
    disabled={props.disabled || props.blocked}
    onPress={() => props.onChange(!value)}
    hitSlop={6}
    style={{ width: TRACK_W, height: TRACK_H, borderRadius: 999, flexShrink: 0, overflow: 'hidden', opacity: props.disabled ? 0.35 : 1 }}
  >
    <Animated.View style={{ ...fill, backgroundColor: tint(colors.foreground, 0.16), opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }} />
    <Animated.View style={{ ...fill, backgroundColor: colors.statusSuccess, opacity: progress }} />
    <Animated.View style={{ position: 'absolute', top: INSET, left: INSET, width: THUMB, height: THUMB, borderRadius: 999, backgroundColor: '#ffffff', transform: [{ translateX: travel }] }} />
  </Pressable>;
}

export function Chip(props: { label: string; colors: Colors; tone?: Tone; selected?: boolean; icon?: string; onPress?(): void }) {
  const { colors } = props;
  const tone = props.tone ?? 'muted';
  const fg = props.selected ? colors.surface0 : toneColor(colors, tone);
  const style = {
    flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, paddingHorizontal: 7, height: 20, borderRadius: 6, flexShrink: 0,
    backgroundColor: props.selected ? colors.foreground : tone === 'muted' ? tint(colors.foreground, 0.07) : tint(fg, 0.12),
  };
  const body = <>
    {props.icon ? <Icon name={props.icon} size={11} color={fg} /> : null}
    <Text numberOfLines={1} style={{ color: fg, fontSize: 11, fontWeight: '600' }}>{props.label}</Text>
  </>;
  return props.onPress
    ? <Pressable accessibilityRole="button" accessibilityLabel={props.label} accessibilityState={{ selected: props.selected }} onPress={props.onPress} style={style}>{body}</Pressable>
    : <View style={style}>{body}</View>;
}

/** Segmented control; `small` sits inside forms. */
export function Tabs<Id extends string>(props: {
  value: Id;
  onChange(value: Id): void;
  items: readonly { id: Id; label: string; count?: number; alert?: boolean }[];
  colors: Colors;
  small?: boolean;
}) {
  const { colors } = props;
  return <View accessibilityRole="tablist" style={{ flexDirection: 'row', flexWrap: 'wrap', maxWidth: '100%', alignSelf: 'flex-start', gap: 2, padding: 3, borderRadius: 10, backgroundColor: tint(colors.foreground, 0.06) }}>
    {props.items.map(item => {
      const selected = item.id === props.value;
      return <Pressable
        key={item.id}
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        accessibilityLabel={item.label}
        onPress={() => props.onChange(item.id)}
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 6, height: props.small ? 24 : 28, paddingHorizontal: props.small ? 10 : 12, borderRadius: 7,
          backgroundColor: selected ? tint(colors.foreground, 0.12) : 'transparent',
        }}
      >
        <Text style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 12, fontWeight: '600' }}>{item.label}</Text>
        {item.count !== undefined ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{item.count}</Text> : null}
        {item.alert ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.statusWarning }} /> : null}
      </Pressable>;
    })}
  </View>;
}

/** One bordered box with a hairline between its rows. */
export function List(props: { colors: Colors; children: ReactNode }) {
  const { colors } = props;
  const rows = Children.toArray(props.children);
  return <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 12, overflow: 'hidden', backgroundColor: colors.surface1 }}>
    {rows.map((row, index) => <View key={isValidElement(row) && row.key !== null ? row.key : index} style={{ borderTopWidth: index ? 1 : 0, borderTopColor: outline(colors) }}>{row}</View>)}
  </View>;
}

export function Card(props: { colors: Colors; children: ReactNode }) {
  return <View style={{ borderWidth: 1, borderColor: outline(props.colors), borderRadius: 12, padding: 14, gap: 12, backgroundColor: props.colors.surface1 }}>{props.children}</View>;
}

/** Small section title with an optional count, hint, and expand chevron. */
export function Heading(props: { title: string; count?: number | string; hint?: string; colors: Colors; open?: boolean; onToggle?(): void }) {
  const { colors } = props;
  const head = <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    {props.onToggle ? <Icon name={props.open ? 'ChevronDown' : 'ChevronRight'} size={14} color={colors.foregroundMuted} /> : null}
    <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{props.title}</Text>
    {props.count !== undefined ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{props.count}</Text> : null}
  </View>;
  return <View style={{ gap: 2 }}>
    {props.onToggle
      ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: props.open }} accessibilityLabel={props.title} onPress={props.onToggle} style={{ alignSelf: 'flex-start' }}>{head}</Pressable>
      : head}
    {props.hint ? <Muted colors={colors} small>{props.hint}</Muted> : null}
  </View>;
}

export function Empty(props: { icon: string; title: string; hint?: string; colors: Colors }) {
  const { colors } = props;
  return <View style={{ alignItems: 'center', gap: 6, paddingVertical: 28, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: outline(colors) }}>
    <Icon name={props.icon} size={20} color={colors.foregroundMuted} />
    <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600', textAlign: 'center' }}>{props.title}</Text>
    {props.hint ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17, textAlign: 'center' }}>{props.hint}</Text> : null}
  </View>;
}

export function Banner(props: { tone: Tone; colors: Colors; children: ReactNode; onClose?(): void }) {
  const { colors } = props;
  const color = toneColor(colors, props.tone);
  return <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: tint(color, 0.35), backgroundColor: tint(color, 0.08) }}>
    <View style={{ paddingTop: 1 }}><Icon name={props.tone === 'danger' ? 'CircleAlert' : 'TriangleAlert'} size={14} color={color} /></View>
    <Text selectable style={{ flex: 1, color: colors.foreground, fontSize: 12, lineHeight: 17 }}>{props.children}</Text>
    {props.onClose ? <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={props.onClose} hitSlop={6}><Icon name="X" size={14} color={colors.foregroundMuted} /></Pressable> : null}
  </View>;
}

export function Field(props: {
  label?: string;
  value: string;
  onChange(value: string): void;
  colors: Colors;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  /** Hides the value, for a token or password. */
  secure?: boolean;
  /** Leading icon; a field with one also gets a clear button. */
  icon?: string;
  onSubmit?(): void;
}) {
  const { colors } = props;
  return <View style={{ gap: 5 }}>
    {props.label ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' }}>{props.label}</Text> : null}
    <View style={{ justifyContent: 'center' }}>
      {props.icon ? <View pointerEvents="none" style={{ position: 'absolute', left: 10, zIndex: 1 }}><Icon name={props.icon} size={14} color={colors.foregroundMuted} /></View> : null}
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        onSubmitEditing={props.onSubmit}
        placeholder={props.placeholder}
        placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
        multiline={props.multiline}
        secureTextEntry={props.secure}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          minHeight: props.multiline ? 76 : 32, paddingLeft: props.icon ? 32 : 10, paddingRight: props.icon ? 30 : 10, paddingVertical: 7,
          borderRadius: 8, borderWidth: 1, borderColor: outline(colors), backgroundColor: tint(colors.foreground, 0.03),
          color: colors.foreground, fontSize: 12, textAlignVertical: props.multiline ? 'top' : 'center',
          fontFamily: props.mono ? MONO : undefined, outlineStyle: 'solid', outlineWidth: 0,
        }}
      />
      {props.icon && props.value
        ? <Pressable accessibilityRole="button" accessibilityLabel="Clear" onPress={() => props.onChange('')} hitSlop={6} style={{ position: 'absolute', right: 9 }}>
          <Icon name="X" size={14} color={colors.foregroundMuted} />
        </Pressable>
        : null}
    </View>
  </View>;
}

export function Muted(props: { colors: Colors; children: ReactNode; danger?: boolean; selectable?: boolean; small?: boolean; mono?: boolean; lines?: number }) {
  return <Text
    selectable={props.selectable}
    numberOfLines={props.lines}
    style={{
      color: props.danger ? props.colors.statusDanger : props.colors.foregroundMuted,
      fontSize: props.small || props.mono ? 11 : 12, lineHeight: props.small || props.mono ? 16 : 17, fontFamily: props.mono ? MONO : undefined,
    }}
  >{props.children}</Text>;
}

export function Dot(props: { color: string }) {
  return <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: props.color }} />;
}
