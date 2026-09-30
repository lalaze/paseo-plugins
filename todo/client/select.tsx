import { useState } from 'react';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ui } from './i18n';
import { outline, tint, type Colors } from './kit';

export interface SelectOption {
  value: string;
  label: string;
}

/** Past this many options the list gets a filter box; branch and model lists run long. */
const SEARCH_FROM = 7;

/**
 * A pill that shows the current choice and opens its options above itself. Opening upward keeps the list inside
 * the dialog instead of under its scroll clip. The parent owns `open` so only one list is open at a time.
 */
export function Select(props: {
  label: string;
  icon: string;
  value: string;
  options: readonly SelectOption[];
  placeholder: string;
  colors: Colors;
  open: boolean;
  disabled?: boolean;
  onOpenChange(open: boolean): void;
  onChange(value: string): void;
}) {
  const { colors } = props;
  const [query, setQuery] = useState('');
  const selected = props.options.find(option => option.value === props.value);
  const needle = query.trim().toLowerCase();
  const shown = needle ? props.options.filter(option => option.label.toLowerCase().includes(needle)) : props.options;
  const toggle = () => { setQuery(''); props.onOpenChange(!props.open); };
  return <View style={{ position: 'relative', zIndex: props.open ? 20 : 1, flexShrink: 1, minWidth: 0 }}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${selected?.label ?? props.placeholder}`}
      accessibilityState={{ expanded: props.open, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={toggle}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, maxWidth: 260, paddingHorizontal: 11, borderRadius: 999,
        backgroundColor: props.open || pressed ? tint(colors.foreground, 0.12) : colors.surface2,
      })}
    >
      <Icon name={props.icon} size={13} color={colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 12, fontWeight: '500' }}>
        {selected?.label ?? props.placeholder}
      </Text>
      {props.disabled ? null : <Icon name="ChevronDown" size={13} color={colors.foregroundMuted} />}
    </Pressable>
    {props.open ? <View style={{
      position: 'absolute', bottom: 38, left: 0, width: 300, maxHeight: 280, padding: 4, gap: 4,
      borderRadius: 12, borderWidth: 1, borderColor: outline(colors), backgroundColor: colors.surface1,
      shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
    }}>
      <Text style={{ paddingHorizontal: 8, paddingTop: 6, color: colors.foregroundMuted, fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' }}>{props.label}</Text>
      {props.options.length >= SEARCH_FROM ? <TextInput
        value={query}
        onChangeText={setQuery}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={ui('Filter…', '筛选…')}
        placeholderTextColor={tint(colors.foregroundMuted, 0.6)}
        style={{ height: 30, marginHorizontal: 4, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: outline(colors), color: colors.foreground, fontSize: 12, outlineStyle: 'solid', outlineWidth: 0 }}
      /> : null}
      <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
        {shown.length === 0
          ? <Text style={{ padding: 10, color: colors.foregroundMuted, fontSize: 12 }}>{ui('No match', '没有匹配项')}</Text>
          : shown.map(option => <Pressable
            key={option.value}
            accessibilityRole="menuitem"
            accessibilityState={{ selected: option.value === props.value }}
            onPress={() => { props.onChange(option.value); props.onOpenChange(false); }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 7, borderRadius: 8, backgroundColor: pressed ? colors.surface2 : 'transparent' })}
          >
            <View style={{ width: 14 }}>{option.value === props.value ? <Icon name="Check" size={13} color={colors.foreground} /> : null}</View>
            <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: 12 }}>{option.label}</Text>
          </Pressable>)}
      </ScrollView>
    </View> : null}
  </View>;
}
