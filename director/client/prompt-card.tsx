import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAgent, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PromptCardData } from "./prompt-model";
import { Card, Label, outline } from "./ui";
import { Disclosure } from "./settings-controls";
import { ui } from "./i18n";

const stages = {
  plan: { title: ui("Plan", "设计总纲"), instruction: ui("Read the project, design the implementation, split the work, and define acceptance criteria.", "阅读项目，制定实现方案，拆分任务并写清验收要求。") },
  execute: { title: ui("Implement task", "实现任务"), instruction: ui("Complete this task from the plan, verify it, and report any problems.", "按总纲完成本项任务，验证结果并说明遇到的问题。") },
  review: { title: ui("Review task", "审核任务"), instruction: ui("Inspect the code and result, verify the acceptance criteria, and approve or request rework.", "检查实际代码与执行结果，按验收要求验证，决定通过或返工。") },
  final: { title: ui("Final review", "统一审核"), instruction: ui("Review the integrated result, checking each goal and user change request before handing it to the user for acceptance.", "检查全部任务的集成成果，逐项核对目标和用户的修改要求；通过后交给用户验收。") },
};
function instructionSource(source: string): string {
  const roles: Record<string, string> = {
    "Planning AI instructions": ui("Planning AI instructions", "设计 AI 前置提示词"),
    "Implementation AI instructions": ui("Implementation AI instructions", "执行 AI 前置提示词"),
    "Review AI instructions": ui("Review AI instructions", "审核 AI 前置提示词"),
  };
  if (roles[source]) return roles[source];
  const extra = /^Additional instructions for (.+)$/.exec(source);
  return extra ? ui(source, `${extra[1]} 的补充提示词`) : source;
}
export function DirectorPromptCard({ item, theme, layout, agentId }: PluginTimelineItemProps<PromptCardData>) {
  const [expanded, setExpanded] = useState(false), [focused, setFocused] = useState(false);
  const owner = useAgent(agentId, agent => agent.labels["director-role"]);
  const data = item.data, stage = stages[data.stage];
  if (owner === "chat") return <View style={{ paddingVertical: 6 }}><Disclosure theme={theme} title={ui(`Background handoff · ${stage.title}`, `后台交接 · ${stage.title}`)} summary={ui("The main agent is handling this collaboration step", "主 Agent 正在处理本轮协作事项")}><Label theme={theme} muted>{data.goal}</Label></Disclosure></View>;
  const actor = data.actor ?? (data.stage === "execute" ? ui("Implementation AI", "执行 AI") : ui("Lead AI", "总 AI"));
  return <View style={{ width: "100%", maxWidth: 900, minWidth: 0, alignSelf: "center", paddingVertical: 8 }}>
    <Card theme={theme} title={`${actor} · ${stage.title}`}>
      <Label theme={theme} muted>{ui("Automatic AI collaboration handoff · current task", "AI 协作自动交接 · 本轮任务")}</Label>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 17, lineHeight: 25, fontWeight: "600" }}>{data.goal}</Text>
      <Label theme={theme}>{stage.instruction}</Label>
      {!!data.preInstructions?.length && <Disclosure theme={theme} title={ui("Instructions for this step", "本轮前置提示词")} summary={ui(`${data.preInstructions.length} requirements · expand to see the sent content`, `${data.preInstructions.length} 项要求 · 展开查看实际发送的内容`)}>
        {data.preInstructions.map((entry, index) => <View key={index} style={{ gap: 4 }}><Label theme={theme} muted>{instructionSource(entry.source)}</Label><Label theme={theme}>{entry.text}</Label></View>)}
      </Disclosure>}
      {!!data.changes?.length && <View style={{ gap: 4 }}><Label theme={theme}>{ui("Additional user change requests", "用户追加的修改意见")}</Label>{data.changes.map((change, i) => <Label key={i} theme={theme}>{i + 1}. {change}</Label>)}</View>}
      {data.team.map(person => <View key={person.role} style={{ gap: 3 }}><Label theme={theme} muted>{person.role}</Label><Label theme={theme}>{person.name}</Label></View>)}
      {data.task && <View style={{ gap: 5 }}><Label theme={theme}>{ui(`Task: ${data.task}`, `本项任务：${data.task}`)}</Label><Label theme={theme} muted>{data.description}</Label></View>}
      {data.acceptance.length > 0 && <View style={{ gap: 4 }}><Label theme={theme}>{ui("Acceptance criteria", "验收要求")}</Label>{data.acceptance.map((criterion, index) => <Label key={index} theme={theme} muted>{index + 1}. {criterion}</Label>)}</View>}
      {data.files.length > 0 && <Label theme={theme} muted>{ui(`Scope: ${data.files.join(", ")}`, `修改范围：${data.files.join("、")}`)}</Label>}
      <View style={{ padding: 12, borderLeftWidth: 3, borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2, borderRadius: 6 }}><Label theme={theme}>{data.next}</Label></View>
      {data.branch && <Label theme={theme} muted>{ui(`Result branch: ${data.branch}`, `成果分支：${data.branch}`)}</Label>}
      <Label theme={theme} muted>{ui(`Code directory: ${data.cwd}`, `代码目录：${data.cwd}`)}</Label>
      <Pressable accessibilityRole="button" accessibilityLabel={ui("View raw instructions", "查看原始指令")} accessibilityState={{ expanded }} aria-expanded={expanded} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPress={() => setExpanded(value => !value)} style={{ minHeight: 44, padding: 10, borderWidth: 1, borderColor: focused ? theme.colors.accent : outline(theme, "panel"), borderRadius: 8 }}>
        <Label theme={theme} muted>{expanded ? ui("▴ Hide raw instructions", "▴ 收起原始指令") : ui("▾ View raw instructions", "▾ 查看原始指令")}</Label>
      </Pressable>
      {expanded && <ScrollView nestedScrollEnabled style={{ maxHeight: 400 }}><Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontFamily: layout.platform === "ios" ? "Menlo" : "monospace" }}>{data.raw}</Text></ScrollView>}
    </Card>
  </View>;
}
