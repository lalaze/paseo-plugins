import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAgent, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { isDirectorReply, type ReplyCardData } from "./reply-model";
import { Card, Label, outline, type Theme } from "./ui";
import { ui } from "./i18n";

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
  const title = data.kind === "draft" ? `${data.stage ? { plan: ui("Plan", "设计总纲"), result: ui("Implementation result", "执行结果"), review: ui("Review", "审核意见") }[data.stage] : ui("AI reply", "AI 回复")} · ${running ? ui("Generating", "生成中") : ui("Pending formatting", "待整理")}`
    : data.kind === "plan" ? ui("Plan", "设计总纲")
    : data.kind === "result" ? data.payload.status === "blocked" ? ui("Implementation result · blocked", "执行结果 · 遇到阻碍") : ui("Implementation result · awaiting review", "执行结果 · 待审核")
      : ui(`Review · ${{ approved: "approved", changes_requested: "changes requested", blocked: "blocked" }[data.payload.decision]}`, `审核意见 · ${{ approved: "通过", changes_requested: "需要修改", blocked: "暂无法通过" }[data.payload.decision]}`);
  return <View style={{ width: "100%", maxWidth: 900, minWidth: 0, alignSelf: "center", paddingVertical: 8 }}>
    <Card theme={theme} title={title}>
      <Label theme={theme} muted>{owner === "worker" ? ui("Implementation AI response", "执行 AI 的本轮回复") : owner === "reviewer" ? ui("Review AI response", "审核 AI 的本轮回复") : ui("Planning AI response", "设计 AI 的本轮回复")}</Label>
      <Label theme={theme}>{data.kind === "draft" ? data.summary || (running ? ui("Generating response…", "正在生成回复…") : ui("No summary is available.", "暂无可展示的摘要。")) : data.payload.summary}</Label>
      {data.kind === "draft" && <>
        {Boolean(data.architecture) && <Section title={ui("Implementation approach", "实现方案")} theme={theme} initiallyOpen><Label theme={theme}>{data.architecture}</Label></Section>}
        <Label theme={theme} muted>{running ? ui("The response is still being generated. Task assignments and review decisions depend on the complete result.", "回复仍在生成，任务安排和审核结论以完整结果为准。") : ui("This response could not be fully parsed. Ask for its status in the main conversation.", "这段回复尚未完整解析，请在主对话询问处理状态。")}</Label>
      </>}
      {data.kind === "plan" && <>
        <Section title={ui("Implementation approach", "实现方案")} theme={theme} initiallyOpen><Label theme={theme}>{data.payload.architecture}</Label></Section>
        <Points title={ui("Overall acceptance criteria", "整体验收要求")} theme={theme} items={data.payload.acceptance} />
        <Label theme={theme}>{ui(`Task plan · ${data.payload.tasks.length} items`, `任务安排 · 共 ${data.payload.tasks.length} 项`)}</Label>
        {data.payload.tasks.map((task, index) => <Section key={task.id} title={ui(`Task ${index + 1} · ${task.title}`, `任务 ${index + 1} · ${task.title}`)} theme={theme}>
          <Label theme={theme}>{task.description}</Label>
          <Label theme={theme} muted>{ui(`Scope: ${task.files.join(", ")}`, `修改范围：${task.files.join("、")}`)}</Label>
          <Label theme={theme} muted>{ui(`Dependencies: ${task.dependsOn.map(id => data.payload.tasks.find(t => t.id === id)?.title ?? id).join(", ") || "none; ready to start"}`, `前置任务：${task.dependsOn.map(id => data.payload.tasks.find(t => t.id === id)?.title ?? id).join("、") || "无，可直接开始"}`)}</Label>
          <Points title={ui("Task acceptance criteria", "本项验收要求")} theme={theme} items={task.acceptance} />
        </Section>)}
      </>}
      {data.kind === "result" && <>
        {data.payload.tests.length ? <Points title={ui("Verification reported by the implementation AI", "执行 AI 报告的验证")} items={data.payload.tests} theme={theme} /> : <Label theme={theme} muted>{ui("No verification was reported for this step.", "本轮未报告验证记录。")}</Label>}
        {data.payload.issues.length ? <Points title={ui("Known issues", "已知问题")} items={data.payload.issues} theme={theme} /> : <Label theme={theme} muted>{ui("The implementation AI reported no known issues.", "执行 AI 未报告已知问题。")}</Label>}
      </>}
      {data.kind === "review" && <>
        <Label theme={theme}>{ui("Acceptance review", "逐项验收意见")}</Label>
        {data.payload.criteria.map((criterion, index) => <View key={index} style={{ gap: 5 }}>
          <Label theme={theme}>{criterion.passed ? ui("✓ Passed", "✓ 通过") : ui("✗ Failed", "✗ 未通过")} · {criterion.criterion}</Label><Label theme={theme} muted>{criterion.evidence}</Label>
        </View>)}
        {data.payload.findings.map((finding, index) => <Section key={index} title={ui(`Required change ${index + 1} · ${finding.location}`, `修改要求 ${index + 1} · ${finding.location}`)} theme={theme} initiallyOpen>
          <Label theme={theme}>{ui(`Problem: ${finding.problem}`, `问题：${finding.problem}`)}</Label><Label theme={theme}>{ui(`Change: ${finding.change}`, `修改方法：${finding.change}`)}</Label><Label theme={theme}>{ui(`Verification: ${finding.verification}`, `复验要求：${finding.verification}`)}</Label><Label theme={theme} muted>{ui(`Task: ${finding.taskId}`, `对应任务：${finding.taskId}`)}</Label>
        </Section>)}
      </>}
      <Label theme={theme} muted>{ui("This result is validated in the background. Ask for the latest task status in the main conversation.", "本轮结果由后台校验，最新任务状态可在主对话中询问。")}</Label>
      <Section title={ui("View raw response", "查看原始回复")} theme={theme}><ScrollView nestedScrollEnabled style={{ maxHeight: 400 }}><Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, fontFamily: layout.platform === "ios" ? "Menlo" : "monospace" }}>{data.raw}</Text></ScrollView></Section>
    </Card>
  </View>;
}
