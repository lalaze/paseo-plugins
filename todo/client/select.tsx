import { useEffect, useRef, useState } from 'react';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ui } from './i18n';
import { outline, tint, type Colors } from './kit';

export interface SelectOption {
  value: string;
  label: string;
  /** With more than one group the menu opens on a list of groups and drills into one; the trigger shows `group · label`. */
  group?: string;
}

/** Past this many options the menu gets a search row; branch and model lists run long. */
const SEARCH_FROM = 7;
const ROW = 32;

type Row =
  | { kind: 'group'; group: string; count: number; current: string | null }
  | { kind: 'option'; option: SelectOption; showGroup: boolean };

function shownLabel(option: SelectOption): string {
  return option.group ? `${option.group} · ${option.label}` : option.label;
}

function groupsOf(options: readonly SelectOption[]): string[] {
  const seen: string[] = [];
  for (const option of options) if (option.group && !seen.includes(option.group)) seen.push(option.group);
  return seen;
}

/**
 * A pill showing the current choice that opens a searchable menu above itself, so the menu stays inside the dialog
 * instead of under its scroll clip. Grouped options browse like Paseo's own model picker: groups first, then one
 * group's options, while a search matches across all groups. One highlighted row follows the pointer and the arrow
 * keys; Enter picks or opens it, Escape steps back and then closes. The parent owns `open`.
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
  const [view, setView] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  // Pressing a group row or Back moves focus off the search box; put it back so typing and arrow keys keep working.
  const search = useRef<TextInput>(null);
  const selected = props.options.find(option => option.value === props.value);
  const groups = groupsOf(props.options);
  const drill = groups.length > 1;
  const needle = query.trim().toLowerCase();

  const rows: Row[] = needle
    ? props.options.filter(option => shownLabel(option).toLowerCase().includes(needle)).map(option => ({ kind: 'option', option, showGroup: drill }))
    : drill && view === null
      ? groups.map(group => ({
        kind: 'group', group,
        count: props.options.filter(option => option.group === group).length,
        current: selected?.group === group ? selected.label : null,
      }))
      : props.options.filter(option => !drill || option.group === view).map(option => ({ kind: 'option', option, showGroup: false }));

  // Every open starts at the top level, highlighting where the current choice lives.
  useEffect(() => {
    if (!props.open) return;
    setQuery('');
    setView(null);
    setActive(Math.max(0, drill
      ? groups.indexOf(selected?.group ?? '')
      : props.options.findIndex(option => option.value === props.value)));
  }, [props.open]);
  useEffect(() => { if (needle) setActive(0); }, [needle]);

  const enter = (group: string) => {
    setView(group);
    const inGroup = props.options.filter(option => option.group === group);
    setActive(Math.max(0, inGroup.findIndex(option => option.value === props.value)));
    search.current?.focus();
  };
  const back = () => {
    setActive(Math.max(0, groups.indexOf(view ?? '')));
    setView(null);
    search.current?.focus();
  };
  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'group') { enter(row.group); return; }
    props.onChange(row.option.value);
    props.onOpenChange(false);
  };
  const onKey = (key: string) => {
    if (key === 'Escape') { if (drill && view !== null && !needle) back(); else props.onOpenChange(false); }
    else if (key === 'ArrowDown') setActive(index => Math.min(rows.length - 1, index + 1));
    else if (key === 'ArrowUp') setActive(index => Math.max(0, index - 1));
    else if (key === 'ArrowRight' && rows[active]?.kind === 'group') activate(rows[active]);
    else if ((key === 'ArrowLeft' || key === 'Backspace') && !query && drill && view !== null) back();
    else if (key === 'Enter') activate(rows[active]);
  };

  const searchable = props.options.length >= SEARCH_FROM;
  const hint = drill && view === null ? ui('Search all models…', '搜索全部模型…') : ui(`Search ${props.label.toLowerCase()}…`, `搜索${props.label}…`);

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
          ref={search}
          value={query}
          onChangeText={setQuery}
          onKeyPress={event => onKey(event.nativeEvent.key)}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={hint}
          placeholder={hint}
          placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
          style={{ flex: 1, height: 40, padding: 0, color: colors.foreground, fontSize: 13, outlineStyle: 'solid', outlineWidth: 0 }}
        />
      </View> : null}
      {drill && view !== null && !needle ? <Pressable
        accessibilityRole="button"
        accessibilityLabel={ui(`Back to all ${props.label.toLowerCase()} providers`, '返回全部供应商')}
        onPress={back}
        style={({ pressed }) => ({ flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: outline(colors), backgroundColor: pressed ? colors.surface2 : 'transparent' })}
      >
        <Icon name="ChevronLeft" size={15} color={colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{view}</Text>
      </Pressable> : null}
      <ScrollView style={{ maxHeight: ROW * 8 + 8 }} contentContainerStyle={{ padding: 4 }} keyboardShouldPersistTaps="handled">
        {rows.length === 0
          ? <Text style={{ paddingVertical: 18, textAlign: 'center', color: colors.foregroundMuted, fontSize: 12 }}>{ui('No match', '没有匹配项')}</Text>
          : rows.map((row, index) => {
            const isActive = index === active;
            const rowStyle = {
              flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, height: ROW, paddingHorizontal: 8, borderRadius: 8,
              backgroundColor: isActive ? tint(colors.foreground, 0.08) : 'transparent',
            };
            if (row.kind === 'group') {
              return <Pressable key={`group:${row.group}`} accessibilityRole="menuitem" accessibilityLabel={`${row.group}, ${row.count}`} onHoverIn={() => setActive(index)} onPress={() => activate(row)} style={rowStyle}>
                <Text numberOfLines={1} style={{ flexShrink: 0, color: colors.foreground, fontSize: 13, fontWeight: row.current ? '600' : '400' }}>{row.group}</Text>
                <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', color: colors.foregroundMuted, fontSize: 12 }}>{row.current ?? row.count}</Text>
                <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
              </Pressable>;
            }
            const isSelected = row.option.value === props.value;
            return <Pressable key={row.option.value} accessibilityRole="menuitem" accessibilityState={{ selected: isSelected }} onHoverIn={() => setActive(index)} onPress={() => activate(row)} style={rowStyle}>
              <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: 13, fontWeight: isSelected ? '600' : '400' }}>{row.option.label}</Text>
              {row.showGroup && row.option.group ? <Text numberOfLines={1} style={{ maxWidth: 110, color: colors.foregroundMuted, fontSize: 12 }}>{row.option.group}</Text> : null}
              {isSelected ? <Icon name="Check" size={14} color={colors.foreground} /> : null}
            </Pressable>;
          })}
      </ScrollView>
    </View> : null}
  </View>;
}
