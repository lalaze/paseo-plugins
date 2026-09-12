import { Text, View } from "react-native";
import { Label, outline, type Theme } from "./ui";
import type { StatusTone } from "./run-model";

const toneColor = (theme: Theme, tone: StatusTone) => ({ accent: theme.colors.accent, success: theme.colors.statusSuccess, warning: theme.colors.statusWarning, danger: theme.colors.statusDanger, muted: theme.colors.foregroundMuted })[tone];

export function StatusBadge({ label, tone, theme }: { label: string; tone: StatusTone; theme: Theme }) {
  return <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 20, borderWidth: 1, borderColor: outline(theme, "panel"), backgroundColor: theme.colors.surface0 }}>
    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: toneColor(theme, tone) }} />
    <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text>
  </View>;
}

export function RunProgress({ stage, completed, done, total, theme }: { stage: number; completed: boolean; done: number; total: number; theme: Theme }) {
  return <View style={{ gap: 12 }}>
    <View style={{ flexDirection: "row", gap: 6 }}>
      {["设计总纲", "执行与审核", "最终审核", "你的验收"].map((label, index) => {
        const passed = completed || index < stage, current = !completed && index === stage;
        return <View key={label} accessibilityLabel={`${label}：${passed ? "已完成" : current ? "当前阶段" : "尚未开始"}`} style={{ flex: 1, minWidth: 0, gap: 7 }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: passed ? theme.colors.statusSuccess : current ? theme.colors.accent : outline(theme, "panel") }} />
          <Text style={{ fontSize: 12, lineHeight: 18, color: current ? theme.colors.foreground : theme.colors.foregroundMuted, fontWeight: current ? "700" : "400" }}>{passed ? "✓" : index + 1} {label}</Text>
        </View>;
      })}
    </View>
    <Label theme={theme} muted>{total ? `子任务已通过审核 ${done} / ${total}` : "总纲生成后会显示子任务进度"}</Label>
  </View>;
}
