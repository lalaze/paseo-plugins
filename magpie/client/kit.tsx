import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { Icon, Modal, ScrollView, TextInput, copyText } from "@getpaseo/plugin/client/react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import type { Action, Choice } from "../shared/rpc";
import { logos } from "./logos";

type Colors = PluginScreenProps["theme"]["colors"];
// Magpie's own app.css tokens, selected by the host's light/dark appearance.
export function magpieColors(host: Colors): Colors {
  const color = host.surface0.replace(/^#([\da-f])([\da-f])([\da-f])$/i, "#$1$1$2$2$3$3");
  const rgb = color.startsWith("#")
    ? color
        .slice(1)
        .match(/[\da-f]{2}/gi)
        ?.slice(0, 3)
        .map((v) => parseInt(v, 16))
    : color
        .match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/)
        ?.slice(1, 4)
        .map(Number);
  const dark = rgb ? rgb.reduce((a, b) => a + b, 0) < 384 : true;
  return {
    surface0: dark ? "#1a1a1e" : "#f4f4f6",
    surface1: dark ? "#232327" : "#ffffff",
    surface2: dark ? "#2d2d33" : "#f1f1f4",
    border: dark ? "#333339" : "#e3e3e8",
    foreground: dark ? "#ededf1" : "#1c1c21",
    foregroundMuted: dark ? "#8b8b94" : "#85858d",
    accent: dark ? "#a5b4fc" : "#4f46e5",
    accentForeground: dark ? "#14142a" : "#ffffff",
    statusSuccess: dark ? "#6fd99b" : "#189a58",
    statusWarning: dark ? "#f2b544" : "#b45309",
    statusDanger: dark ? "#f28b82" : "#d64545",
  };
}
export function tint(color: string, alpha: string) {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color;
}

export function createStyles(c: Colors, compact: boolean) {
  return StyleSheet.create({
    root: { flex: 1, minHeight: 0, backgroundColor: c.surface0 },
    frame: { flex: 1, minHeight: 0, flexDirection: compact ? "column" : "row" },
    nav: {
      width: compact ? "100%" : 212,
      borderRightWidth: compact ? 0 : 1,
      borderBottomWidth: compact ? 1 : 0,
      borderColor: c.border,
      backgroundColor: c.surface0,
      padding: compact ? 0 : 10,
    },
    navItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
      paddingHorizontal: compact ? 12 : 8,
      height: compact ? 36 : 30,
      borderRadius: 7,
      marginBottom: compact ? 0 : 1,
    },
    navActive: { backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border },
    navLabel: { color: c.foregroundMuted, fontSize: 13, fontWeight: "500" },
    navLabelActive: { color: c.foreground, fontWeight: "500" },
    navGroup: {
      fontSize: 11,
      fontWeight: "500",
      color: c.foregroundMuted,
      marginTop: 14,
      marginBottom: 4,
      marginLeft: 8,
      letterSpacing: 0.4,
    },
    brand: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      height: 36,
    },
    brandText: { color: c.foreground, fontSize: 13.5, fontWeight: "600" },
    navFoot: { gap: 8, paddingTop: 8, borderTopWidth: 1, borderColor: c.border },
    topbar: {
      height: compact ? 50 : 46,
      paddingHorizontal: compact ? 16 : 20,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    toolbar: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
    search: { width: compact ? "100%" : 220, minWidth: 0 },
    body: { flex: 1, minWidth: 0, minHeight: 0 },
    content: {
      paddingHorizontal: 16,
      paddingTop: 2,
      paddingBottom: 24,
      gap: 12,
      width: "100%",
      maxWidth: 1232,
      alignSelf: "center",
    },
    header: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 14 },
    heading: { flex: 1, minWidth: 180, gap: 5 },
    title: { color: c.foreground, fontSize: 13.5, fontWeight: "600" },
    subtitle: { color: c.foregroundMuted, fontSize: 12, lineHeight: 19 },
    section: { gap: 10 },
    sectionTitle: { color: c.foreground, fontSize: 13, fontWeight: "600" },
    row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
    between: {
      flexDirection: "row",
      flexWrap: compact ? "wrap" : "nowrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    grow: { flex: 1, minWidth: 0 },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
    list: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.surface1,
      overflow: "hidden",
    },
    listItem: {
      paddingHorizontal: 14,
      paddingVertical: compact ? 12 : 8,
      gap: 8,
      borderTopWidth: 1,
      borderColor: c.border,
      minWidth: 0,
    },
    listHead: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 34 },
    agentFields: {
      width: compact ? "100%" : 350,
      maxWidth: "100%",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 5,
    },
    editor: { padding: 14, gap: 12, backgroundColor: c.surface0, borderRadius: 8 },
    card: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      padding: compact ? 14 : 16,
      gap: 12,
      backgroundColor: c.surface1,
    },
    cardColumn: { flexGrow: 1, flexBasis: compact ? "100%" : 360, minWidth: compact ? 0 : 300 },
    cardTitle: { color: c.foreground, fontSize: 13, fontWeight: "500" },
    text: { color: c.foreground, fontSize: 13, lineHeight: 18 },
    muted: { color: c.foregroundMuted, fontSize: 12, lineHeight: 18 },
    small: { color: c.foregroundMuted, fontSize: 11.5, lineHeight: 16 },
    divider: { height: 1, backgroundColor: c.border },
    button: {
      minHeight: compact ? 34 : 26,
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderWidth: 0,
      borderColor: "transparent",
      borderRadius: 6,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      backgroundColor: c.surface2,
    },
    primaryButton: { backgroundColor: c.accent, borderColor: c.accent },
    dangerButton: { backgroundColor: tint(c.statusDanger, "12") },
    buttonText: { color: c.foreground, fontSize: 12, fontWeight: "500" },
    iconButton: {
      width: compact ? 34 : 26,
      height: compact ? 34 : 26,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 6,
    },
    input: {
      color: c.foreground,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      minHeight: compact ? 42 : 28,
      paddingHorizontal: 11,
      paddingVertical: compact ? 9 : 5,
      fontSize: 12,
      backgroundColor: c.surface1,
      outlineWidth: 0,
    },
    multiline: { minHeight: 96, textAlignVertical: "top" },
    inlinePicker: { flex: 1, minWidth: 100, maxWidth: "100%", gap: 5 },
    pill: {
      borderWidth: 0,
      backgroundColor: c.surface2,
      minHeight: compact ? 32 : 25,
      borderRadius: 6,
      paddingVertical: 3,
      paddingHorizontal: 8,
    },
    field: {
      gap: 6,
      minWidth: compact ? 0 : 230,
      width: compact ? "100%" : undefined,
      maxWidth: "100%",
    },
    label: { color: c.foregroundMuted, fontSize: 11, fontWeight: "600" },
    choice: {
      maxHeight: 240,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      backgroundColor: c.surface0,
    },
    choiceRow: {
      padding: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderBottomWidth: 1,
      borderColor: c.border,
    },
    chip: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: 999,
      backgroundColor: c.surface2,
    },
    banner: {
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      padding: 12,
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 9,
      backgroundColor: c.surface1,
    },
    empty: {
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      padding: 38,
      backgroundColor: c.surface1,
      borderRadius: 12,
    },
    iconTile: {
      width: 22,
      height: 22,
      alignItems: "center",
      justifyContent: "center",
    },
    metric: {
      flexGrow: 1,
      flexBasis: 140,
      padding: 14,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.surface1,
      gap: 8,
    },
    metricValue: { color: c.foreground, fontSize: 22, fontWeight: "600", letterSpacing: -0.4 },
    tableRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderColor: c.border,
    },
    barTrack: {
      height: 5,
      backgroundColor: tint(c.foreground, "10"),
      borderRadius: 3,
      overflow: "hidden",
    },
    selected: { backgroundColor: tint(c.accent, "12") },
    pressed: { opacity: 0.65 },
    disabled: { opacity: 0.4 },
    transcript: {
      gap: 10,
      padding: 16,
      backgroundColor: c.surface0,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: c.border,
    },
  });
}
type Ui = {
  c: Colors;
  s: ReturnType<typeof createStyles>;
  compact: boolean;
  busy: boolean;
  error: string;
  notice: string;
  run(action: Action): Promise<boolean>;
};
const UiContext = createContext<Ui | null>(null);
export function UiProvider({
  colors,
  compact,
  busy,
  run,
  error = "",
  notice = "",
  children,
}: {
  colors: Colors;
  compact: boolean;
  busy: boolean;
  run: Ui["run"];
  error?: string;
  notice?: string;
  children: ReactNode;
}) {
  const palette = useMemo(() => magpieColors(colors), [colors]);
  const s = useMemo(() => createStyles(palette, compact), [palette, compact]);
  const value = useMemo(
    () => ({ c: palette, s, compact, busy, run, error, notice }),
    [palette, s, compact, busy, run, error, notice],
  );
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}
export function useUi() {
  const value = useContext(UiContext);
  if (!value) throw new Error("Missing Magpie UI context");
  return value;
}
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const { c, s, compact, busy, run, error, notice } = useUi();
  return (
    <Modal
      title={title}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Content
        style={{ backgroundColor: c.surface0 }}
        contentContainerStyle={{ padding: compact ? 16 : 24, gap: 12 }}
      >
        {/* Native sheets may mount in a separate root; carry the plugin's UI context explicitly. */}
        <UiProvider
          colors={c}
          compact={compact}
          busy={busy}
          run={run}
          error={error}
          notice={notice}
        >
          <View style={s.section}>
            {error ? <Banner error>{error}</Banner> : null}
            {notice ? <Banner>{notice}</Banner> : null}
            {children}
          </View>
        </UiProvider>
      </Modal.Content>
    </Modal>
  );
}
export function BrandIcon({
  id,
  size = 22,
  fallback = "Box",
}: {
  id: string;
  size?: number;
  fallback?: string;
}) {
  const { c } = useUi();
  const key = Object.entries({
    magpie: "favicon",
    claude: "claudecode-color",
    codex: "codex-color",
    cursor: "cursor",
    gemini: "geminicli-color",
    openai: "openai",
    opencode: "opencode",
    antigravity: "antigravity-color",
    copilot: "copilot-color",
    deepseek: "deepseek-color",
    vscode: "vscode",
    "vs code": "vscode",
    kimi: "kimi",
    qwen: "qwen-color",
    grok: "grok",
    pi: "pi",
  }).find(
    ([name]) => id.toLowerCase() === name || (name !== "pi" && id.toLowerCase().includes(name)),
  )?.[1];
  return key && logos[key] ? (
    <Image
      source={{ uri: logos[key] }}
      resizeMode="contain"
      style={{
        width: size,
        height: size,
        ...(!key.endsWith("-color") ? { tintColor: c.foreground } : {}),
      }}
    />
  ) : (
    <Icon name={fallback} size={size} color={c.foregroundMuted} />
  );
}
export function Button({
  label,
  accessibilityLabel,
  icon,
  onPress,
  primary,
  danger,
  disabled,
}: {
  label: string;
  accessibilityLabel?: string;
  icon?: string;
  onPress(): void;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { c, s, busy } = useUi();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        primary && s.primaryButton,
        danger && s.dangerButton,
        pressed && s.pressed,
        (disabled || busy) && s.disabled,
      ]}
    >
      {icon ? (
        <Icon
          name={icon}
          size={13}
          color={primary ? c.accentForeground : danger ? c.statusDanger : c.foregroundMuted}
        />
      ) : null}
      <Text
        style={[
          s.buttonText,
          primary && { color: c.accentForeground },
          danger && { color: c.statusDanger },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function IconButton({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: string;
  onPress(): void;
}) {
  const { c, s, busy } = useUi();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [s.iconButton, pressed && s.pressed]}
    >
      <Icon name={icon} size={15} color={c.foregroundMuted} />
    </Pressable>
  );
}
export function Segments({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange(value: string): void;
}) {
  const { c, s } = useUi();
  return (
    <View
      style={{
        flexDirection: "row",
        padding: 2,
        borderRadius: 7,
        backgroundColor: c.surface2,
        alignSelf: "flex-start",
      }}
    >
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="button"
          accessibilityLabel={option.label}
          accessibilityState={{ selected: value === option.value }}
          onPress={() => onChange(option.value)}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 5,
            backgroundColor: value === option.value ? c.surface1 : "transparent",
          }}
        >
          <Text style={[s.muted, value === option.value && { color: c.foreground }]}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
export function StatusDot({ good, label }: { good: boolean; label?: string }) {
  const { c, s } = useUi();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: good ? c.statusSuccess : c.foregroundMuted,
        }}
      />
      {label ? <Text style={s.small}>{label}</Text> : null}
    </View>
  );
}
export function ConfirmButton({
  label,
  detail,
  icon,
  onConfirm,
}: {
  label: string;
  detail?: string;
  icon?: string;
  onConfirm(): void;
}) {
  const [asking, setAsking] = useState(false);
  const { s } = useUi();
  return asking ? (
    <View style={s.section}>
      <Text style={s.muted}>{detail || `确认${label}？`}</Text>
      <View style={s.row}>
        <Button
          label={`确认${label}`}
          danger
          onPress={() => {
            setAsking(false);
            onConfirm();
          }}
        />
        <Button label="取消" onPress={() => setAsking(false)} />
      </View>
    </View>
  ) : (
    <Button label={label} icon={icon} danger onPress={() => setAsking(true)} />
  );
}
export function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
  multiline,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  secure?: boolean;
  multiline?: boolean;
}) {
  const { c, s, busy } = useUi();
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={!busy}
        placeholder={placeholder}
        placeholderTextColor={c.foregroundMuted}
        secureTextEntry={secure}
        multiline={multiline}
        autoCapitalize="none"
        autoCorrect={false}
        style={[s.input, multiline && s.multiline]}
      />
    </View>
  );
}
export function ChoicePicker({
  label,
  value,
  options,
  onChange,
  inline,
}: {
  label: string;
  value: string;
  options: Choice[];
  onChange(value: string): void;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { c, s, busy } = useUi();
  const selected = options.find((o) => o.value === value);
  const filtered = options.filter((o) =>
    `${o.label} ${o.note} ${o.value}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <View style={inline ? s.inlinePicker : s.field}>
      {!inline ? <Text style={s.label}>{label}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}：${selected?.label || value || "请选择"}`}
        accessibilityState={{ expanded: open }}
        disabled={busy || !options.length}
        onPress={() => setOpen(!open)}
        style={[s.input, s.between, inline && s.pill]}
      >
        <Text numberOfLines={1} style={[s.text, s.grow, inline && { fontSize: 12.5 }]}>
          {selected?.label || value || "请选择"}
        </Text>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={13} color={c.foregroundMuted} />
      </Pressable>
      {open ? (
        <View style={s.choice}>
          {options.length > 8 ? (
            <TextInput
              accessibilityLabel={`搜索${label}`}
              placeholder="搜索…"
              placeholderTextColor={c.foregroundMuted}
              value={query}
              onChangeText={setQuery}
              style={s.input}
            />
          ) : null}
          <ScrollView nestedScrollEnabled>
            {filtered.map((o) => (
              <Pressable
                key={o.value}
                accessibilityRole="button"
                accessibilityLabel={o.label}
                onPress={() => {
                  onChange(o.value);
                  setOpen(false);
                  setQuery("");
                }}
                style={[s.choiceRow, value === o.value && s.selected]}
              >
                <View style={s.grow}>
                  <Text style={s.text}>{o.label}</Text>
                  {o.note ? <Text style={s.small}>{o.note}</Text> : null}
                </View>
                {value === o.value ? <Icon name="Check" size={13} color={c.accent} /> : null}
              </Pressable>
            ))}
            {!filtered.length ? <Text style={s.muted}>没有匹配项</Text> : null}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
export function Toggle({
  label,
  value,
  onChange,
  disabled,
  hideLabel,
}: {
  label: string;
  value: boolean;
  onChange(value: boolean): void;
  disabled?: boolean;
  hideLabel?: boolean;
}) {
  const { c, s, busy } = useUi();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={() => onChange(!value)}
      style={s.row}
    >
      <View
        style={{
          width: 32,
          height: 19,
          borderRadius: 10,
          padding: 2,
          backgroundColor: value ? c.foreground : tint(c.foregroundMuted, "30"),
          alignItems: value ? "flex-end" : "flex-start",
          opacity: disabled || busy ? 0.4 : 1,
        }}
      >
        <View style={{ width: 15, height: 15, borderRadius: 8, backgroundColor: c.surface1 }} />
      </View>
      {!hideLabel ? <Text style={s.muted}>{label}</Text> : null}
    </Pressable>
  );
}
export function Chip({ label, good, danger }: { label: string; good?: boolean; danger?: boolean }) {
  const { c, s } = useUi();
  return (
    <View style={s.chip}>
      <Text
        style={[s.small, good && { color: c.statusSuccess }, danger && { color: c.statusDanger }]}
      >
        {label}
      </Text>
    </View>
  );
}
export function Banner({ children, error }: { children: ReactNode; error?: boolean }) {
  const { c, s } = useUi();
  return (
    <View accessibilityRole={error ? "alert" : undefined} style={s.banner}>
      <Icon
        name={error ? "CircleAlert" : "Info"}
        size={15}
        color={error ? c.statusDanger : c.foregroundMuted}
      />
      <Text selectable style={[s.muted, s.grow, error && { color: c.statusDanger }]}>
        {children}
      </Text>
    </View>
  );
}
export function Empty({
  title,
  hint,
  icon = "Inbox",
}: {
  title: string;
  hint?: string;
  icon?: string;
}) {
  const { c, s } = useUi();
  return (
    <View style={s.empty}>
      <Icon name={icon} size={27} color={c.foregroundMuted} />
      <Text style={s.cardTitle}>{title}</Text>
      {hint ? <Text style={s.muted}>{hint}</Text> : null}
    </View>
  );
}
export function Card({
  children,
  column,
  style,
}: {
  children: ReactNode;
  column?: boolean;
  style?: ViewStyle;
}) {
  const { s } = useUi();
  return <View style={[s.card, column && s.cardColumn, style]}>{children}</View>;
}
export function Metric({
  label,
  value,
  grouped,
}: {
  label: string;
  value: string;
  grouped?: boolean;
}) {
  const { s } = useUi();
  return (
    <View style={[s.metric, grouped && { borderWidth: 0, borderRadius: 0, gap: 3 }]}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.metricValue}>{value}</Text>
    </View>
  );
}
export function CopyButton({ value, label = "复制" }: { value: string; label?: string }) {
  const [state, setState] = useState(label);
  return (
    <Button
      label={state}
      icon="Copy"
      onPress={() => {
        void copyText(value).then(
          () => setState("已复制"),
          () => setState("复制失败"),
        );
      }}
    />
  );
}
export function number(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
export function money(value: number) {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}
export function date(value: string) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
