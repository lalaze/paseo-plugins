import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { ResponseSpeedData } from "../shared/metrics";

const seconds = (milliseconds: number | null) => milliseconds === null
  ? "—"
  : milliseconds < 1000
    ? `${milliseconds} ms`
    : `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;

const rate = (value: number | null) => value === null ? "—" : `${value.toFixed(1)} t/s`;
const tokens = (value: number | null) => value === null ? "—" : value.toLocaleString("en-US");

export function ResponseSpeed({ item, theme }: PluginTimelineItemProps<ResponseSpeedData>) {
  const data = item.data;
  const name = data.model ? `${data.provider} / ${data.model}` : data.provider;
  const primary = data.streamTokensPerSecond ?? data.totalTokensPerSecond;
  const primaryLabel = data.streamTokensPerSecond === null ? "全程速度" : "生成速度";
  const status = data.status === "completed" ? null : data.status === "failed" ? "未完成" : "已取消";
  return <View
    accessibilityRole="summary"
    accessibilityLabel={`${name}，${primaryLabel} ${rate(primary)}，输出 ${tokens(data.outputTokens)} token，首字延迟 ${seconds(data.ttftMs)}，总耗时 ${seconds(data.totalMs)}`}
    style={{ width: "100%", maxWidth: 900, minWidth: 0, alignSelf: "center", paddingVertical: 4 }}
  >
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 8 }}>
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", maxWidth: 260 }}>{name}</Text>
      <Text style={{ color: primary === null ? theme.colors.foregroundMuted : theme.colors.accent, fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{primaryLabel} {rate(primary)}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>输出 {tokens(data.outputTokens)} token</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>TTFT {seconds(data.ttftMs)}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>全程 {rate(data.totalTokensPerSecond)} · {seconds(data.totalMs)}</Text>
      {status ? <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>{status}</Text> : null}
    </View>
  </View>;
}
