import { View } from "react-native";
import { useState } from "react";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getRunRpc, controlRunRpc } from "../shared/rpc";
import { hasFinalResult, canResumeRun, operationLabel } from "../shared/schema";
import { Button, Card, ErrorText, Label, Field } from "./ui";
import { Disclosure } from "./settings-controls";
import { phaseLabels, runPresentation } from "./run-model";
import { RunProgress, StatusBadge } from "./run-progress";
import { EvidenceDetails, ReviewDetails } from "./run-evidence";

export function RunDetail({ id, hostId, theme, navigation }: { id: string; hostId: string } & Pick<PluginSurfaceProps, "theme" | "navigation">) {
  const [newGoal, setNewGoal] = useState("");
  const [feedback, setFeedback] = useState("");
  const [editingFeedback, setEditingFeedback] = useState(false);
  const [visibleEvents, setVisibleEvents] = useState(12);
  const get = useRpc(getRunRpc), control = useRpc(controlRunRpc);
  const query = useQuery({ queryKey: ["director", hostId, "run", id], queryFn: () => get({ id }), refetchInterval: 2500 });
  const action = useMutation({ mutationFn: control, onSuccess: async (_data, input) => { if (input.action === "request_changes") { setFeedback(""); setEditingFeedback(false); } await query.refetch(); }, onError: () => { void query.refetch(); } });
  const run = query.data;
  if (!run) return <Card theme={theme} title={query.isError ? "暂时无法读取任务" : "正在读取任务"}><Label theme={theme} muted>{query.isError ? "检查主机连接后重新读取。" : "正在恢复最新进度…"}</Label><ErrorText theme={theme} error={query.error} />{query.isError && <Button theme={theme} secondary label="重新读取任务" disabled={query.isFetching} onPress={() => { void query.refetch(); }} />}</Card>;
  const active = run.operations.find(o => o.id === run.activeOperationId);
  const presentation = runPresentation(run);
  const { ended, awaitingFinal, awaitingPlan: awaitingPlanApproval } = presentation;
  const finalAvailable = hasFinalResult(run);
  const designLabel = operationLabel(run.settings, "plan"), reviewLabel = operationLabel(run.settings, "review");
  const finalInput = { id, artifactId: run.finalEvidence?.id, expectedRevision: run.revision };
  return <View style={{ gap: 16 }}>
    <Card theme={theme} title="任务进度">
      <StatusBadge theme={theme} {...presentation.status} />
      <Label theme={theme}>{run.goal.length > 240 ? `${run.goal.slice(0, 240)}…` : run.goal}</Label>
      <RunProgress theme={theme} stage={presentation.stage} completed={run.userAcceptance?.decision === "approved" && run.phase === "completed"} done={presentation.done} total={run.tasks.length} />
      <View accessibilityLiveRegion="polite" style={{ gap: 6, padding: 12, backgroundColor: theme.colors.surface0, borderRadius: 8 }}>
        <Label theme={theme}>{presentation.next}</Label>
        {!!run.message && <Label theme={theme} muted>{run.message}</Label>}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {run.control === "paused" && canResumeRun(run) && <Button theme={theme} label="继续" disabled={action.isPending} onPress={() => action.mutate({ id, action: "resume" })} />}
        {awaitingPlanApproval && <Button theme={theme} label="总纲通过，开始执行" disabled={action.isPending} onPress={() => action.mutate({ id, action: "approve_plan" })} />}
        {!ended && run.control === "needs_attention" && <Button theme={theme} label="我已检查，重试此步骤" disabled={action.isPending} onPress={() => action.mutate({ id, action: "retry" })} />}
        {active?.agentId && navigation && <Button theme={theme} secondary={run.control !== "waiting_permission"} label={run.control === "waiting_permission" ? "打开 AI 会话，处理请求" : "打开当前 AI 会话"} onPress={() => navigation.openAgent({ agentId: active.agentId! })} />}
        {!ended && !awaitingFinal && ["running", "waiting_permission"].includes(run.control) && <Button theme={theme} secondary label="暂停派发" disabled={action.isPending} onPress={() => action.mutate({ id, action: "pause" })} />}
        {!ended && !awaitingFinal && <Button theme={theme} secondary label={run.control === "canceling" ? "正在停止…" : "取消任务"} disabled={action.isPending || run.control === "canceling"} onPress={() => action.mutate({ id, action: "cancel" })} />}
      </View>
      <ErrorText theme={theme} error={finalAvailable ? query.error : action.error ?? query.error} />
      {query.isError && <><Label theme={theme} muted>以上为上次读取的进度，连接恢复后会自动更新。</Label><Button theme={theme} secondary label="刷新任务进度" disabled={query.isFetching} onPress={() => { void query.refetch(); }} /></>}
      <Disclosure theme={theme} title="任务信息与 AI 会话" summary={`${run.branch} · 本轮调用 ${run.operations.length - (run.roundOperationOffset ?? 0)}/${run.settings.maxAttempts}`}>
        <Label theme={theme}>完整目标：{run.goal}</Label>
        <Label theme={theme} muted>{run.workspaceId ? "会话位于发起任务的工作区" : "会话位于独立工作区"}{"\n"}成果分支：{run.branch}{"\n"}代码目录：{run.cwd}</Label>
        <Label theme={theme} muted>设计 AI：{run.settings.profiles.find(p => p.id === run.settings.directorProfileId)?.provider}{"\n"}审核 AI：{run.settings.profiles.find(p => p.id === (run.settings.reviewerProfileId ?? run.settings.directorProfileId))?.provider}{run.settings.reviewerProfileId ? "（独立会话）" : "（沿用设计会话）"}</Label>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {run.directorAgentId && navigation && <Button theme={theme} secondary label={`打开${designLabel} 会话`} onPress={() => navigation.openAgent({ agentId: run.directorAgentId! })} />}
          {run.reviewerAgentId && navigation && <Button theme={theme} secondary label="打开审核 AI 会话" onPress={() => navigation.openAgent({ agentId: run.reviewerAgentId! })} />}
        </View>
        {!ended && !awaitingFinal && <Label theme={theme} muted>取消会停止当前任务，保留现有文件和成果分支。</Label>}
      </Disclosure>
      {!ended && !awaitingFinal && ["paused", "needs_attention"].includes(run.control) && <Disclosure theme={theme} title="需要修改任务目标？" summary="仅在需求变化时填写；确认现有总纲无需填写。"><Field theme={theme} label="修改后的完整目标" multiline value={newGoal} onChange={setNewGoal} placeholder="包含原需求与新增要求，保存后重新设计和审核" /><Button theme={theme} secondary label="停止本轮并按新要求重新设计" disabled={!newGoal.trim() || action.isPending} onPress={() => action.mutate({ id, action: "revise", goal: newGoal })} /></Disclosure>}
    </Card>
    {finalAvailable && <Card theme={theme} title={awaitingFinal ? "交付成果与验收" : "已交付的成果"}>
      <Label theme={theme}>{run.finalReview!.summary}</Label>
      {run.finalEvidence && <View style={{ gap: 4 }}>
        <Label theme={theme}>变更文件 · {run.finalEvidence.changedFiles.length} 个</Label>
        {run.finalEvidence.changedFiles.slice(0, 6).map(file => <Label key={file} theme={theme} muted>{file}</Label>)}
        {run.finalEvidence.changedFiles.length > 6 && <Label theme={theme} muted>其余文件可在“查看代码差异”中展开。</Label>}
      </View>}
      <ReviewDetails theme={theme} review={run.finalReview!} />
      {run.finalEvidence && <EvidenceDetails theme={theme} evidence={run.finalEvidence} />}
      <Label theme={theme} muted>成果分支：{run.branch}{"\n"}代码目录：{run.cwd}</Label>
      <Label theme={theme} muted>验收只确认本次成果，合并或推送分支需另外操作。</Label>
      {!editingFeedback && <>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {awaitingFinal && <Button theme={theme} label="验收通过，完成任务" disabled={action.isPending} onPress={() => action.mutate({ ...finalInput, action: "accept_final" })} />}
          <Button theme={theme} secondary label={awaitingFinal ? "提出修改意见" : "继续修改成果"} disabled={action.isPending} onPress={() => setEditingFeedback(true)} />
        </View>
        {awaitingFinal && <Disclosure theme={theme} title="不采纳此成果" summary="结束任务，保留现有文件和成果分支">
          <Button theme={theme} secondary label="不采纳，结束任务" disabled={action.isPending} onPress={() => action.mutate({ ...finalInput, action: "reject_final" })} />
        </Disclosure>}
      </>}
      {editingFeedback && <>
      <Field theme={theme} disabled={action.isPending} label="希望怎么修改？" multiline value={feedback} onChange={setFeedback} placeholder="只写需要调整或补充的地方，例如：错误提示不清楚，请说明原因并提供重试入口。无需重写原目标。" />
      <Label theme={theme} muted>{designLabel}安排修改 → 执行 AI 实现 → {reviewLabel}复审 → 再交给你验收。{run.settings.requirePlanApproval ? "你启用了总纲确认，修改计划也会先等你批准。" : "修改计划生成后自动执行。"}</Label>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Button theme={theme} label="提交修改意见，继续改" disabled={!feedback.trim() || feedback.trim().length > 16000 || action.isPending} onPress={() => action.mutate({ ...finalInput, action: "request_changes", feedback })} />
      <Button theme={theme} secondary label="取消修改" disabled={action.isPending} onPress={() => { setFeedback(""); setEditingFeedback(false); }} />
      </View>
      {feedback.trim().length > 16000 && <Label theme={theme}>修改意见最多 16000 字，请缩短后提交。</Label>}
      </>}
      <ErrorText theme={theme} error={action.error} />
    </Card>}
    {run.finalReview && !finalAvailable && <Card theme={theme} title={`${reviewLabel}最终审核`}><Label theme={theme}>{run.finalReview.summary}</Label><ReviewDetails theme={theme} review={run.finalReview} />{run.finalEvidence && <EvidenceDetails theme={theme} evidence={run.finalEvidence} />}</Card>}
    {!!run.changeRequests?.length && <Disclosure theme={theme} title="你的修改意见" summary={`共 ${run.changeRequests.length} 轮修改 · 展开查看历史`}>{run.changeRequests.map((change, i) => <View key={i} style={{ gap: 4 }}><Label theme={theme} muted>{new Date(change.requestedAt).toLocaleString()} · 第 {change.planVersion} 版</Label><Label theme={theme}>{change.feedback}</Label></View>)}</Disclosure>}
    {run.plan && <Card theme={theme} title="设计总纲"><Label theme={theme}>{run.plan.summary}</Label>{run.plan.acceptance.map((a, i) => <Label key={i} theme={theme}>• {a}</Label>)}<Disclosure key={`${run.planVersion ?? 1}:${awaitingPlanApproval}`} theme={theme} title="实现方案" summary={`${run.tasks.length} 项子任务 · ${awaitingPlanApproval ? "请确认方案后开始执行" : "展开查看架构与实现安排"}`} defaultOpen={awaitingPlanApproval}><Label theme={theme}>{run.plan.architecture}</Label></Disclosure></Card>}
    {run.tasks.map(task => <Card theme={theme} key={task.spec.id} title={`${task.spec.title} · ${phaseLabels[task.status]}`}>
      <Label theme={theme} muted>{task.spec.id} · {run.settings.profiles.find(p => p.id === task.profileId)?.label} · 返工 {task.reworks}/{run.settings.maxReworks}</Label>
      {task.result && <Label theme={theme}>执行结果：{task.result.summary}</Label>}
      {task.review && <Label theme={theme}>审核：{task.review.summary}</Label>}
      {task.feedback && <Label theme={theme}>修改要求：{task.feedback}</Label>}
      <Disclosure theme={theme} title="任务要求与验收标准" summary={`${task.spec.files.length} 项修改范围 · ${task.spec.acceptance.length} 项验收要求`}>
        <Label theme={theme}>{task.spec.description}</Label>
        <Label theme={theme} muted>修改范围：{task.spec.files.join("、")}{"\n"}前置任务：{task.spec.dependsOn.join("、") || "无"}</Label>
        {task.spec.acceptance.map((a, i) => <Label theme={theme} key={i}>• {a}</Label>)}
      </Disclosure>
      {task.review && <Disclosure theme={theme} title="逐项审核依据" summary={`${task.review.criteria.filter(c => c.passed).length} / ${task.review.criteria.length} 项通过`}><ReviewDetails theme={theme} review={task.review} /></Disclosure>}
      {task.evidence && <EvidenceDetails theme={theme} evidence={task.evidence} />}
      {task.agentId && navigation && <Button theme={theme} secondary label="打开执行会话" onPress={() => navigation.openAgent({ agentId: task.agentId! })} />}
    </Card>)}
    <Card theme={theme} title="运行记录">
      {awaitingPlanApproval && <View style={{ gap: 8 }}>
        <Label theme={theme}>下一步：确认设计总纲。你启用了总纲确认，批准后才会派发执行 AI。</Label>
        <Button theme={theme} label={action.isPending ? "正在确认…" : "总纲通过，开始执行"} disabled={action.isPending} onPress={() => action.mutate({ id, action: "approve_plan" })} />
      </View>}
      <ErrorText theme={theme} error={action.error ?? query.error} />
      <Label theme={theme} muted>最近 {Math.min(visibleEvents, run.events.length)} 条，共 {run.events.length} 条 · 最新在前</Label>
      {run.events.slice(-visibleEvents).reverse().map((e, i) => <Label theme={theme} muted key={`${run.events.length - i}:${e.time}`}>{new Date(e.time).toLocaleString()} · {e.message}</Label>)}
      {run.events.length > visibleEvents && <Button theme={theme} secondary label="查看更早的记录" onPress={() => setVisibleEvents(n => n + 30)} />}
    </Card>
  </View>;
}
