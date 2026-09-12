import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";

export type Theme = PluginTheme;
// Keep the host palette, but give controls and containers distinct outlines.
export function outline(theme: Theme, kind: "control" | "panel" = "control") {
  function rgb(color: string) {
    const hex = color.replace(/^#/, "");
    if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(hex)) return null;
    const full = hex.length === 3 ? hex.split("").map(c => c + c).join("") : hex;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  }
  const base = rgb(theme.colors.border) ?? rgb(theme.colors.surface1);
  const ink = rgb(theme.colors.foregroundMuted) ?? rgb(theme.colors.foreground);
  if (!base || !ink) return theme.colors.foregroundMuted;
  const weight = kind === "control" ? 0.65 : 0.35;
  return `#${base.map((value, i) => Math.round(value + (ink[i] - value) * weight).toString(16).padStart(2, "0")).join("")}`;
}
export function Label({ children, theme, muted = false }: { children: ReactNode; theme: Theme; muted?: boolean }) {
  return <Text selectable style={{ color: muted ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: 14, lineHeight: 21 }}>{children}</Text>;
}
export function Button({ label, onPress, theme, disabled = false, secondary = false, selected }: { label: string; onPress: () => void; theme: Theme; disabled?: boolean; secondary?: boolean; selected?: boolean }) {
  const [focused, setFocused] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={({ pressed }) => ({ backgroundColor: secondary ? theme.colors.surface2 : theme.colors.accent, borderWidth: 2, borderColor: focused || selected ? theme.colors.foreground : secondary ? outline(theme, "panel") : theme.colors.accent, paddingHorizontal: 13, paddingVertical: 9, minHeight: 44, maxWidth: "100%", justifyContent: "center", borderRadius: 8, opacity: disabled ? 0.5 : pressed ? 0.75 : 1, alignSelf: "flex-start" })}><Text style={{ color: secondary ? theme.colors.foreground : theme.colors.accentForeground, fontWeight: "600" }}>{label}</Text></Pressable>;
}
export function Field({ label, value, onChange, theme, multiline = false, placeholder, secure = false, disabled = false }: { label: string; value: string; onChange: (s: string) => void; theme: Theme; multiline?: boolean; placeholder?: string; secure?: boolean; disabled?: boolean }) {
  const [focused, setFocused] = useState(false);
  return <View style={{ gap: 5 }}><Label theme={theme}>{label}</Label><TextInput accessibilityLabel={label} accessibilityState={{ disabled }} editable={!disabled} value={value} onChangeText={onChange} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} multiline={multiline} autoCapitalize="none" autoCorrect={false} secureTextEntry={secure} placeholder={placeholder} placeholderTextColor={theme.colors.foregroundMuted} style={{ backgroundColor: theme.colors.surface0, borderWidth: 2, borderColor: focused ? theme.colors.accent : outline(theme), outlineStyle: "solid", outlineWidth: 0, color: theme.colors.foreground, borderRadius: 8, padding: 10, minHeight: multiline ? 100 : 44, textAlignVertical: multiline ? "top" : "center", opacity: disabled ? 0.6 : 1 }} /></View>;
}
export function Choice({ label, value, options, onChange, theme, disabled = false }: { label: string; value: string; options: { id: string; label: string }[]; onChange: (v: string) => void; theme: Theme; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [focused, setFocused] = useState(false), [searchFocused, setSearchFocused] = useState(false);
  const filtered = options.filter(option => `${option.label} ${option.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <View style={{ gap: 6, minWidth: 0 }}>
    <Label theme={theme}>{label}</Label>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open && !disabled, disabled }} disabled={disabled} accessibilityLabel={label} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPress={() => { setOpen(!open); setSearch(""); }} style={{ padding: 11, minHeight: 44, borderWidth: 2, borderColor: open || focused ? theme.colors.accent : outline(theme), borderRadius: 8, backgroundColor: theme.colors.surface0, flexDirection: "row", alignItems: "center", gap: 12, opacity: disabled ? 0.6 : 1 }}><View style={{ flex: 1, minWidth: 0 }}><Label theme={theme}>{options.find(o => o.id === value)?.label ?? "请选择"}</Label></View><Label theme={theme}>{open && !disabled ? "▴" : "▾"}</Label></Pressable>
    {open && !disabled && <View style={{ padding: 8, gap: 8, borderWidth: 1, borderColor: outline(theme), backgroundColor: theme.colors.surface2, borderRadius: 8 }}>
      {options.length > 8 && <TextInput accessibilityLabel={`搜索${label}`} placeholder="搜索名称或模型 ID" placeholderTextColor={theme.colors.foregroundMuted} value={search} onChangeText={setSearch} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} autoCapitalize="none" autoCorrect={false} style={{ minHeight: 44, padding: 10, borderWidth: 2, borderColor: searchFocused ? theme.colors.accent : outline(theme), outlineStyle: "solid", outlineWidth: 0, color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderRadius: 6 }} />}
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{ maxHeight: 260 }} contentContainerStyle={{ gap: 4 }}>
        {filtered.length ? filtered.map(option => <Pressable key={option.id} accessibilityRole="button" accessibilityLabel={option.label} accessibilityState={{ selected: option.id === value }} onPress={() => { onChange(option.id); setOpen(false); }} style={{ padding: 10, minHeight: 44 }}><Label theme={theme}>{option.id === value ? "✓ " : ""}{option.label}</Label></Pressable>) : <Label theme={theme} muted>{options.length ? "没有匹配的选项" : "暂无可用选项"}</Label>}
      </ScrollView>
    </View>}
  </View>;
}
export function Card({ title, children, theme }: { title: string; children: ReactNode; theme: Theme }) {
  return <View style={{ padding: 16, gap: 12, borderWidth: 1, borderColor: outline(theme, "panel"), borderRadius: 12, backgroundColor: theme.colors.surface1 }}><Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 18 }}>{title}</Text>{children}</View>;
}
export function ErrorText({ error, theme }: { error: unknown; theme: Theme }) {
  return error ? <Text accessibilityRole="alert" selectable style={{ color: theme.colors.statusDanger, lineHeight: 21 }}>{error instanceof Error ? error.message : String(error)}</Text> : null;
}
