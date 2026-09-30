import { useEffect, useState } from 'react';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ui } from './i18n';
import { outline, tint, type Colors } from './kit';

export interface SelectOption {
  value: string;
  label: string;
  /** Rows sharing a group sit under one heading; the trigger shows `group · label`. */
  group?: string;
}

/** Past this many options the menu gets a search row; branch and model lists run long. */
const SEARCH_FROM = 7;
const ROW = 32;

function shownLabel(option: SelectOption): string {
  return option.group ? `${option.group} · ${option.label}` : option.label;
}

/**
 * A pill showing the current choice that opens a searchable menu above itself, so the menu stays inside the dialog
 * instead of under its scroll clip. The parent owns `open` so only one menu is open at a time. One highlighted row
 * follows both the pointer and the arrow keys; Enter picks it and Escape closes.
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
  const [active, setActive] = useState(0);
  const selected = props.options.find(option => option.value === props.value);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? props.options.filter(option => shownLabel(option).toLowerCase().includes(needle))
    : props.options;
  const searchable = props.options.length >= SEARCH_FROM;

  // Open on the current choice; a new query starts from the first match.
  useEffect(() => {
    if (!props.open) return;
    setQuery('');
    setActive(Math.max(0, props.options.findIndex(option => option.value === props.value)));
  }, [props.open]);
  useEffect(() => { setActive(0); }, [needle]);

  const pick = (option: SelectOption | undefined) => {
    if (!option) return;
    props.onChange(option.value);
    props.onOpenChange(false);
  };
  const onKey = (key: string) => {
    if (key === 'Escape') props.onOpenChange(false);
    else if (key === 'ArrowDown') setActive(index => Math.min(shown.length - 1, index + 1));
    else if (key === 'ArrowUp') setActive(index => Math.max(0, index - 1));
    else if (key === 'Enter') pick(shown[active]);
  };

  return <View style={{ position: 'relative', zIndex: props.open ? 20 : 1, flexShrink: 1, minWidth: 0 }}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${selected ? shownLabel(selected) : props.placeholder}`}
      accessibilityState={{ expanded: props.open, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onOpenChange(!props.open)}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, maxWidth: 260, paddingHorizontal: 12, borderRadius: 999,
        borderWidth: 1, borderColor: props.open ? tint(colors.foreground, 0.25) : 'transparent',
        backgroundColor: props.open || pressed ? tint(colors.foreground, 0.1) : colors.surface2,
        opacity: props.disabled && !selected ? 0.6 : 1,
      })}
    >
      <Icon name={props.icon} size={13} color={colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 12, fontWeight: '500' }}>
        {selected ? shownLabel(selected) : props.placeholder}
      </Text>
      {props.disabled ? null : <Icon name="ChevronsUpDown" size={12} color={colors.foregroundMuted} />}
    </Pressable>

    {props.open ? <View style={{
      position: 'absolute', bottom: 40, left: 0, width: 288, borderRadius: 14, overflow: 'hidden',
      borderWidth: 1, borderColor: tint(colors.foreground, 0.14), backgroundColor: colors.surface1,
      shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 24, shadowOffset: { width: 0, height: 12 },
    }}>
      {searchable ? <View style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: outline(colors) }}>
        <Icon name="Search" size={14} color={colors.foregroundMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          onKeyPress={event => onKey(event.nativeEvent.key)}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={ui(`Search ${props.label}`, `搜索${props.label}`)}
          placeholder={ui(`Search ${props.label.toLowerCase()}…`, `搜索${props.label}…`)}
          placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
          style={{ flex: 1, height: 40, padding: 0, color: colors.foreground, fontSize: 13, outlineStyle: 'solid', outlineWidth: 0 }}
        />
      </View> : null}
      <ScrollView style={{ maxHeight: ROW * 8 + 16 }} contentContainerStyle={{ padding: 4 }} keyboardShouldPersistTaps="handled">
        {shown.length === 0
          ? <Text style={{ paddingVertical: 18, textAlign: 'center', color: colors.foregroundMuted, fontSize: 12 }}>{ui('No match', '没有匹配项')}</Text>
          : shown.map((option, index) => {
            const heading = option.group && option.group !== shown[index - 1]?.group ? option.group : null;
            const isSelected = option.value === props.value;
            const isActive = index === active;
            return <View key={option.value}>
              {heading ? <Text style={{ paddingHorizontal: 8, paddingTop: index === 0 ? 6 : 10, paddingBottom: 4, color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' }}>{heading}</Text> : null}
              <Pressable
                accessibilityRole="menuitem"
                accessibilityState={{ selected: isSelected }}
                onHoverIn={() => setActive(index)}
                onPress={() => pick(option)}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8, height: ROW, paddingHorizontal: 8, borderRadius: 8,
                  backgroundColor: isActive ? tint(colors.foreground, 0.08) : 'transparent',
                }}
              >
                <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: 13, fontWeight: isSelected ? '600' : '400' }}>{option.label}</Text>
                {isSelected ? <Icon name="Check" size={14} color={colors.foreground} /> : null}
              </Pressable>
            </View>;
          })}
      </ScrollView>
    </View> : null}
  </View>;
}
