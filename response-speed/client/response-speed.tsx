import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { ResponseSpeedData } from "../shared/metrics";
import { resolveUiLocale, ui } from "./i18n";

const seconds = (milliseconds: number | null) => milliseconds === null
  ? "—"
  : milliseconds < 1000
    ? `${milliseconds} ms`
    : `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;

const rate = (value: number | null) => value === null ? "—" : `${value.toFixed(1)} t/s`;
const tokens = (value: number | null) => value === null ? "—" : value.toLocaleString(resolveUiLocale() === "zh-CN" ? "zh-CN" : "en-US");

export function ResponseSpeed({ item, theme, layout }: PluginTimelineItemProps<ResponseSpeedData>) {
  const data = item.data;
  const name = data.model ? `${data.provider} / ${data.model}` : data.provider;
  const primary = data.streamTokensPerSecond ?? data.totalTokensPerSecond;
  const primaryLabel = data.streamTokensPerSecond === null ? ui("Overall", "整体") : ui("Generation", "生成");
  const status = data.status === "completed" ? null : data.status === "failed" ? ui("Failed", "失败") : ui("Canceled", "已取消");
  return <View
    accessibilityRole="summary"
    accessibilityLabel={ui(`${name}, ${primaryLabel} ${rate(primary)}, ${tokens(data.outputTokens)} output tokens, time to first token ${seconds(data.ttftMs)}, total ${seconds(data.totalMs)}`, `${name}，${primaryLabel} ${rate(primary)}，输出 ${tokens(data.outputTokens)} 个 token，首个 token 用时 ${seconds(data.ttftMs)}，总计 ${seconds(data.totalMs)}`)}
    style={{ width: "100%", maxWidth: 900, minWidth: 0, alignSelf: "center", marginTop: layout.compact ? -10 : -22, marginBottom: layout.compact ? -2 : -8 }}
  >
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 7, rowGap: 2, paddingVertical: 1 }}>
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600", maxWidth: 260 }}>{name}</Text>
      <Text style={{ color: primary === null ? theme.colors.foregroundMuted : theme.colors.accent, fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{primaryLabel} {rate(primary)}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{tokens(data.outputTokens)} {ui("tokens", "token")}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>TTFT {seconds(data.ttftMs)}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{ui("Overall", "整体")} {rate(data.totalTokensPerSecond)} · {seconds(data.totalMs)}</Text>
      {status ? <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{status}</Text> : null}
    </View>
  </View>;
}
