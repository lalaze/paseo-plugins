import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAgent, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { isDirectorReply, type ReplyCardData } from "./reply-model";
import { Card, Label, outline, type Theme } from "./ui";

function Section({ title, children, theme, initiallyOpen = false }: { title: string; children: ReactNode; theme: Theme; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen), [focused, setFocused] = useState(false);
  return <View style={{ gap: 10, minWidth: 0 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} aria-expanded={open} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPress={() => setOpen(value => !value)} style={{ minHeight: 44, padding: 10, borderWidth: 1, borderColor: focused ? theme.colors.accent : outline(theme, "panel"), borderRadius: 8 }}>
      <Label theme={theme}>{open ? "▴ " : "▾ "}{title}</Label>
    </Pressable>
    {open && children}
  </View>;
}

function Points({ title, items, theme }: { title: string; items: string[]; theme: Theme }) {
  return <View style={{ gap: 6 }}><Label theme={theme}>{title}</Label>{items.map((text, index) => <Label theme={theme} key={index} muted>{index + 1}. {text}</Label>)}</View>;
}

export function DirectorReplyCard({ item, agentId, theme, layout }: PluginTimelineItemProps<ReplyCardData>) {
  const data = item.data;
  const owner = useAgent(agentId, agent => isDirectorReply(agent.labels, data.kind) ? agent.labels["director-role"] : undefined);
  // Paseo 0.8 marks assistant-message transforms as complete even while tokens
  // arrive. Use the live agent state for the preview label instead.
  const running = useAgent(agentId, agent => agent.status === "running" || agent.status === "initializing");
  // Ordinary sessions (or unavailable metadata) keep their exact original text.
  if (!owner) return <Text selectable style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 21 }}>{data.raw}</Text>;
  const title = data.kind === "draft" ? `${data.stage ? { plan: "设计总纲", result: "执行结果", review: "审核意见" }[data.stage] : "AI 回复"} · ${running ? "生成中" : "待整理"}`
    : data.kind === "plan" ? "设计总纲"
    : data.kind === "result" ? data.payload.status === "blocked" ? "执行结果 · 遇到阻碍" : "执行结果 · 待审核"
      : `审核意见 · ${{ approved: "通过", changes_requested: "需要修改", blocked: "暂无法通过" }[data.payload.decision]}`;
  return <View style={{ width: "100%", maxWidth: 900, minWidth: 0, alignSelf: "center", paddingVertical: 8 }}>
    <Card theme={theme} title={title}>
      <Label theme={theme} muted>{owner === "worker" ? "执行 AI 的本轮回复" : owner === "reviewer" ? "审核 AI 的本轮回复" : "设计 AI 的本轮回复"}</Label>
      <Label theme={theme}>{data.kind === "draft" ? data.summary || (running ? "正在生成回复…" : "暂无可展示的摘要。") : data.payload.summary}</Label>
      {data.kind === "draft" && <>
        {Boolean(data.architecture) && <Section title="实现方案" theme={theme} initiallyOpen><Label theme={theme}>{data.architecture}</Label></Section>}
        <Label theme={theme} muted>{running ? "回复仍在生成，任务安排和审核结论以完整结果为准。" : "这段回复尚未完整解析，请在主对话询问处理状态。"}</Label>
      </>}
      {data.kind === "plan" && <>
        <Section title="实现方案" theme={theme} initiallyOpen><Label theme={theme}>{data.payload.architecture}</Label></Section>
        <Points title="整体验收要求" theme={theme} items={data.payload.acceptance} />
        <Label theme={theme}>任务安排 · 共 {data.payload.tasks.length} 项</Label>
        {data.payload.tasks.map((task, index) => <Section key={task.id} title={`任务 ${index + 1} · ${task.title}`} theme={theme}>
          <Label theme={theme}>{task.description}</Label>
          <Label theme={theme} muted>修改范围：{task.files.join("、")}</Label>
          <Label theme={theme} muted>前置任务：{task.dependsOn.map(id => data.payload.tasks.find(t => t.id === id)?.title ?? id).join("、") || "无，可直接开始"}</Label>
          <Points title="本项验收要求" theme={theme} items={task.acceptance} />
        </Section>)}
      </>}
      {data.kind === "result" && <>
        {data.payload.tests.length ? <Points title="执行 AI 报告的验证" items={data.payload.tests} theme={theme} /> : <Label theme={theme} muted>本轮未报告验证记录。</Label>}
        {data.payload.issues.length ? <Points title="已知问题" items={data.payload.issues} theme={theme} /> : <Label theme={theme} muted>执行 AI 未报告已知问题。</Label>}
      </>}
      {data.kind === "review" && <>
        <Label theme={theme}>逐项验收意见</Label>
        {data.payload.criteria.map((criterion, index) => <View key={index} style={{ gap: 5 }}>
          <Label theme={theme}>{criterion.passed ? "✓ 通过" : "✗ 未通过"} · {criterion.criterion}</Label><Label theme={theme} muted>{criterion.evidence}</Label>
        </View>)}
        {data.payload.findings.map((finding, index) => <Section key={index} title={`修改要求 ${index + 1} · ${finding.location}`} theme={theme} initiallyOpen>
          <Label theme={theme}>问题：{finding.problem}</Label><Label theme={theme}>修改方法：{finding.change}</Label><Label theme={theme}>复验要求：{finding.verification}</Label><Label theme={theme} muted>对应任务：{finding.taskId}</Label>
        </Section>)}
      </>}
      <Label theme={theme} muted>本轮结果由后台校验，最新任务状态可在主对话中询问。</Label>
      <Section title="查看原始回复" theme={theme}><ScrollView nestedScrollEnabled style={{ maxHeight: 400 }}><Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontFamily: layout.platform === "ios" ? "Menlo" : "monospace" }}>{data.raw}</Text></ScrollView></Section>
    </Card>
  </View>;
}
