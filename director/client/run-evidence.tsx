import { ScrollView, View } from "react-native";
import type { Evidence, Review } from "../shared/schema";
import { Disclosure } from "./settings-controls";
import { Label, type Theme } from "./ui";

export function EvidenceDetails({ evidence, theme }: { evidence: Evidence; theme: Theme }) {
  return <View style={{ gap: 12 }}>
    {evidence.checks.length ? evidence.checks.map((check, index) => <Disclosure key={`${index}:${check.exitCode}`} theme={theme} title={`${check.exitCode === 0 ? "✓" : "✗"} ${check.label}`} summary={check.exitCode === 0 ? "检查通过 · 展开查看输出" : `检查未通过 · 退出码 ${check.exitCode ?? "未完成"}`} defaultOpen={check.exitCode !== 0}>
      <Label theme={theme} muted>{check.output.length > 4000 ? "显示最后 4000 个字符，完整输出保存在日志文件中。" : "检查输出"}</Label>
      <ScrollView nestedScrollEnabled style={{ maxHeight: 240 }}><Label theme={theme}>{check.output.slice(-4000) || "无输出"}</Label></ScrollView>
      <Label theme={theme} muted>完整日志：{check.logPath}</Label>
    </Disclosure>) : <Label theme={theme} muted>未指定额外检查，验证方式与依据见 AI 审核意见。</Label>}
    <Disclosure theme={theme} title="查看代码差异" summary={`${evidence.changedFiles.length} 个变更文件`}>
      {evidence.changedFiles.map(file => <Label theme={theme} key={file}>{file}</Label>)}
      <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}><Label theme={theme}>{evidence.diff.slice(0, 16000) || "此快照没有代码差异。"}</Label></ScrollView>
      {evidence.diff.length > 16000 && <Label theme={theme} muted>显示前 16000 个字符，完整差异保存在下方文件中。</Label>}
      <Label theme={theme} muted>完整差异：{evidence.diffPath}</Label>
    </Disclosure>
  </View>;
}

export function ReviewDetails({ review, theme }: { review: Review; theme: Theme }) {
  return <View style={{ gap: 10 }}>
    {review.criteria.map((criterion, index) => <View key={index} style={{ gap: 3 }}><Label theme={theme}>{criterion.passed ? "✓" : "✗"} {criterion.criterion}</Label><Label theme={theme} muted>{criterion.evidence}</Label></View>)}
    {review.findings.map((finding, index) => <View key={index} style={{ gap: 3 }}><Label theme={theme}>{finding.location}：{finding.problem}</Label><Label theme={theme}>修改要求：{finding.change}</Label><Label theme={theme} muted>验证方式：{finding.verification}</Label></View>)}
  </View>;
}
