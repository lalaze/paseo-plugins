import type { ReactNode } from 'react';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Platform, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';

export type Colors = PluginHostProps['theme']['colors'];

export const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** `#rrggbb` plus an alpha byte. Host colors are hex; anything else is returned as is rather than guessed at. */
export function tint(color: string, alpha: number): string {
  const matched = /^#([0-9a-f]{6})$/i.exec(color);
  if (!matched) return color;
  return `#${matched[1]}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

/** Card and box outline: the plain border token nearly vanishes on the dark canvas. */
export function outline(colors: Colors): string {
  return tint(colors.foreground, 0.12);
}

/**
 * High-coverage fill for the page's main content panel. The host background is often a wallpaper, so
 * a nearly opaque surface keeps text readable while still letting the wallpaper show at the edges.
 */
export function panelFill(colors: Colors, alpha = 0.96): string {
  return tint(colors.surface0, alpha);
}

/** Slightly raised fill for cards and bordered groups inside the main panel. */
export function cardFill(colors: Colors, alpha = 0.94): string {
  return tint(colors.surface1, alpha);
}

/** Fill for inputs and chip tracks that sit on top of a card. */
export function controlFill(colors: Colors, alpha = 0.9): string {
  return tint(colors.surface2, alpha);
}

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger';

/** Primary is filled, danger is a red fill for destructive confirmations, outline is a border, ghost is text. `xs` is the size used on cards. */
export function Button(props: {
  label: string;
  icon?: string;
  onPress(): void;
  colors: Colors;
  variant?: ButtonVariant;
  size?: 'xs' | 'sm';
  disabled?: boolean;
  full?: boolean;
  /** Optional explicit height. Used by the compact Dot page to reach a ~44px touch target without changing every shared caller. */
  height?: number;
  /** Square button showing just the icon; the label stays as the accessibility label. */
  iconOnly?: boolean;
}) {
  const { colors } = props;
  const variant = props.variant ?? 'primary';
  const small = props.size === 'xs';
  const buttonHeight = props.height ?? (small ? 26 : 32);
  const fg = variant === 'primary' || variant === 'danger' ? colors.surface0 : variant === 'ghost' ? colors.foregroundMuted : colors.foreground;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={props.label}
    accessibilityState={{ disabled: props.disabled }}
    aria-disabled={props.disabled}
    disabled={props.disabled}
    onPress={props.onPress}
    style={({ pressed }) => ({
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
      height: buttonHeight, paddingHorizontal: props.iconOnly ? 0 : small ? 9 : 14, borderRadius: small ? 8 : 999,
      width: props.iconOnly ? buttonHeight : undefined, flexShrink: 0,
      alignSelf: props.full ? 'stretch' : 'flex-start',
      backgroundColor: variant === 'primary' ? colors.foreground : variant === 'danger' ? colors.statusDanger : pressed ? colors.surface2 : 'transparent',
      borderWidth: variant === 'outline' ? 1 : 0, borderColor: outline(colors),
      opacity: props.disabled ? 0.45 : pressed && (variant === 'primary' || variant === 'danger') ? 0.85 : 1,
    })}
  >
    {props.icon ? <Icon name={props.icon} size={small ? 12 : 14} color={fg} /> : null}
    {props.iconOnly && props.icon ? null : <Text style={{ color: fg, fontSize: small ? 12 : 13, fontWeight: '600' }}>{props.label}</Text>}
  </Pressable>;
}

/** Toolbar chip. Pressable only when onPress is set; a scoped project filter is not. */
export function Pill(props: { children: ReactNode; colors: Colors; onPress?(): void; active?: boolean; label?: string; style?: StyleProp<ViewStyle> }) {
  const { colors } = props;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={props.label}
    accessibilityState={{ selected: props.active, disabled: !props.onPress }}
    aria-selected={props.active}
    onPress={props.onPress}
    disabled={!props.onPress}
    style={[{
      flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 999,
      backgroundColor: props.active ? tint(colors.foreground, 0.14) : controlFill(colors),
    }, props.style]}
  >
    {props.children}
  </Pressable>;
}

export function SectionTitle(props: { children: ReactNode; colors: Colors }) {
  return <Text style={{ color: props.colors.foregroundMuted, fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' }}>
    {props.children}
  </Text>;
}

export function Dot(props: { colors: Colors }) {
  return <Text style={{ color: tint(props.colors.foregroundMuted, 0.5) }}>·</Text>;
}

/** Dimmed full-area layer that closes the overlay above it when pressed. */
export function Backdrop(props: { onClose(): void; children: ReactNode; align: 'right' | 'center' }) {
  return <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 30, flexDirection: 'row', justifyContent: props.align === 'right' ? 'flex-end' : 'center', alignItems: props.align === 'right' ? 'stretch' : 'center' }}>
    <Pressable accessibilityLabel="Close" onPress={props.onClose} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.5)' }} />
    {props.children}
  </View>;
}
