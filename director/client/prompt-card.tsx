import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PromptCardData } from "./prompt-model";
import { Card, Label, outline } from "./ui";
import { Disclosure } from "./settings-controls";

const stages = {
  plan: { title: "设计总纲", instruction: "阅读项目，制定实现方案，拆分任务并写清验收要求。" },
  execute: { title: "实现任务", instruction: "按总纲完成本项任务，验证结果并说明遇到的问题。" },
  review: { title: "审核任务", instruction: "检查实际代码与执行结果，按验收要求验证，决定通过或返工。" },
  final: { title: "统一审核", instruction: "检查全部任务的集成成果，逐项核对目标和用户的修改要求；通过后交给用户验收。" },
};
export function DirectorPromptCard({ item, theme, layout }: PluginTimelineItemProps<PromptCardData>) {
  const [expanded, setExpanded] = useState(false), [focused, setFocused] = useState(false);
  const data = item.data, stage = stages[data.stage];
  const actor = data.actor ?? (data.stage === "execute" ? "执行 AI" : "总 AI");
  return <View style={{ width: "100%", maxWidth: 900, minWidth: 0, alignSelf: "center", paddingVertical: 8 }}>
    <Card theme={theme} title={`${actor} · ${stage.title}`}>
      <Label theme={theme} muted>AI 协作自动交接 · 本轮任务</Label>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 17, lineHeight: 25, fontWeight: "600" }}>{data.goal}</Text>
      <Label theme={theme}>{stage.instruction}</Label>
      {!!data.preInstructions?.length && <Disclosure theme={theme} title="本轮前置提示词" summary={`${data.preInstructions.length} 项要求 · 展开查看实际发送的内容`}>
        {data.preInstructions.map((entry, index) => <View key={index} style={{ gap: 4 }}><Label theme={theme} muted>{entry.source}</Label><Label theme={theme}>{entry.text}</Label></View>)}
      </Disclosure>}
      {!!data.changes?.length && <View style={{ gap: 4 }}><Label theme={theme}>用户追加的修改意见</Label>{data.changes.map((change, i) => <Label key={i} theme={theme}>{i + 1}. {change}</Label>)}</View>}
      {data.team.map(person => <View key={person.role} style={{ gap: 3 }}><Label theme={theme} muted>{person.role}</Label><Label theme={theme}>{person.name}</Label></View>)}
      {data.task && <View style={{ gap: 5 }}><Label theme={theme}>本项任务：{data.task}</Label><Label theme={theme} muted>{data.description}</Label></View>}
      {data.acceptance.length > 0 && <View style={{ gap: 4 }}><Label theme={theme}>验收要求</Label>{data.acceptance.map((criterion, index) => <Label key={index} theme={theme} muted>{index + 1}. {criterion}</Label>)}</View>}
      {data.files.length > 0 && <Label theme={theme} muted>修改范围：{data.files.join("、")}</Label>}
      <View style={{ padding: 12, borderLeftWidth: 3, borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2, borderRadius: 6 }}><Label theme={theme}>{data.next}</Label></View>
      {data.branch && <Label theme={theme} muted>成果分支：{data.branch}</Label>}
      <Label theme={theme} muted>代码目录：{data.cwd}</Label>
      <Pressable accessibilityRole="button" accessibilityLabel="查看原始指令" accessibilityState={{ expanded }} aria-expanded={expanded} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPress={() => setExpanded(value => !value)} style={{ minHeight: 44, padding: 10, borderWidth: 1, borderColor: focused ? theme.colors.accent : outline(theme, "panel"), borderRadius: 8 }}>
        <Label theme={theme} muted>{expanded ? "▴ 收起原始指令" : "▾ 查看原始指令"}</Label>
      </Pressable>
      {expanded && <ScrollView nestedScrollEnabled style={{ maxHeight: 400 }}><Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontFamily: layout.platform === "ios" ? "Menlo" : "monospace" }}>{data.raw}</Text></ScrollView>}
    </Card>
  </View>;
}
