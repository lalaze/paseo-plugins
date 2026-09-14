import { ScrollView, View } from "react-native";
import { useAgent, useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { resyncConversationRpc, getConversationRpc, listConversationsRpc, controlRunRpc } from "../shared/rpc";
import type { ConversationSummary } from "../shared/conversation";
import { phaseLabels } from "./run-model";
import { Button, ErrorText, Label, outline, type Theme } from "./ui";
import { Disclosure } from "./settings-controls";
import type { LaunchRequests } from "./launch";

export const ConversationLinkSchema = z.object({ conversationId: z.string() });
type OpenAgent = (workspaceId: string, agentId: string) => void;

function AgentRow({ agentId, title, status, theme, workspaceId, openAgent }: { agentId?: string; title: string; status: string; theme: Theme; workspaceId: string; openAgent: OpenAgent }) {
  const live = useAgent(agentId ?? "", a => ({ status: a.status, attention: a.attentionReason }));
  const label = live?.attention === "permission" ? "等待权限" : live?.status === "error" ? "会话出错" : live?.status === "running" ? "运行中" : status;
  return <View style={{ gap: 6, paddingVertical: 10, borderBottomWidth: 1, borderColor: outline(theme, "panel") }}>
    <Label theme={theme}>{title}</Label><Label theme={theme} muted>{label}</Label>
    {agentId && <Button theme={theme} secondary label="打开子 Agent 对话" onPress={() => openAgent(workspaceId, agentId)} />}
  </View>;
}
function Children({ summary, theme, openAgent }: { summary: ConversationSummary; theme: Theme; openAgent: OpenAgent }) {
  const run = summary.run;
  const resync = useRpc(resyncConversationRpc);
  const sync = useMutation({ mutationFn: resync });
  const control = useRpc(controlRunRpc);
  const action = useMutation({ mutationFn: control });
  return <View style={{ gap: 8 }}>
    <ErrorText theme={theme} error={summary.error ?? sync.error} />
    {summary.error && <Button theme={theme} secondary label="重新同步到主对话" disabled={sync.isPending} onPress={() => sync.mutate({ id: summary.id })} />}
    {!run && <Label theme={theme} muted>直接在主对话里提出需求，主 Agent 会安排子任务。</Label>}
    {run && <>
      <Label theme={theme} muted>{run.message}</Label>
      <ErrorText theme={theme} error={action.error} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {run.control === "running" && !["completed", "awaiting_acceptance"].includes(run.phase) && <Button theme={theme} secondary label="暂停派发" disabled={action.isPending} onPress={() => action.mutate({ id: run.id, action: "pause" })} />}
        {run.control === "paused" && run.planApproved && !["completed", "awaiting_acceptance"].includes(run.phase) && <Button theme={theme} secondary label="继续执行" disabled={action.isPending} onPress={() => action.mutate({ id: run.id, action: "resume" })} />}
        {run.control === "needs_attention" && <Button theme={theme} secondary label="检查后重试" disabled={action.isPending} onPress={() => action.mutate({ id: run.id, action: "retry" })} />}
        {run.phase !== "completed" && !["canceled", "canceling"].includes(run.control) && <Disclosure theme={theme} title="停止协作" summary="保留现有代码和成果分支"><Button theme={theme} secondary label="停止整个任务" disabled={action.isPending} onPress={() => action.mutate({ id: run.id, action: "cancel" })} /></Disclosure>}
      </View>
      {!run.tasks.length && <Label theme={theme} muted>尚未派发子任务</Label>}
      {run.tasks.map(task => <AgentRow key={task.spec.id} agentId={task.agentId} title={task.spec.title} status={phaseLabels[task.status] ?? task.status} theme={theme} workspaceId={summary.workspaceId} openAgent={openAgent} />)}
      {run.reviewerAgentId && <AgentRow agentId={run.reviewerAgentId} title="审核 Agent" status={run.phase === "final_review" ? "审核中" : "审核会话"} theme={theme} workspaceId={summary.workspaceId} openAgent={openAgent} />}
      {run.chat?.legacyAgentId && <Button theme={theme} secondary label="查看原主会话历史" onPress={() => openAgent(summary.workspaceId, run.chat!.legacyAgentId!)} />}
    </>}
  </View>;
}
function ChildPopover({ id, theme, openAgent, hostId }: { hostId: string; id: string; theme: Theme; openAgent: OpenAgent }) {
  const get = useRpc(getConversationRpc);
  const query = useQuery({ queryKey: ["director", hostId, "conversation", id], queryFn: () => get({ id }), refetchInterval: 2500 });
  return <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ padding: 14, gap: 10, minWidth: 240 }}>
    <Label theme={theme}>子 Agent</Label><ErrorText theme={theme} error={query.error} />
    {query.data && <Children summary={query.data} theme={theme} openAgent={openAgent} />}
  </ScrollView>;
}
export function createConversationRenderer(openAgent: OpenAgent) {
  return function ConversationLink({ item, theme, agentId, host }: PluginTimelineItemProps<z.infer<typeof ConversationLinkSchema>>) {
    const get = useRpc(getConversationRpc);
    const query = useQuery({ queryKey: ["director", host.id, "conversation", item.data.conversationId], queryFn: () => get({ id: item.data.conversationId }), refetchInterval: 2500 });
    const summary = query.data;
    return <View style={{ gap: 8 }}>
      <ErrorText theme={theme} error={query.error} />
      {summary && summary.agentId !== agentId && summary.agentId ? <Button theme={theme} label="进入新的主对话" onPress={() => openAgent(summary.workspaceId, summary.agentId!)} /> : <Disclosure theme={theme} title="子 Agent" summary="展开查看任务与会话">{summary && <Children summary={summary} theme={theme} openAgent={openAgent} />}</Disclosure>}
    </View>;
  };
}
export function installConversationControls(client: PluginClientContext, requests: LaunchRequests) {
  const registrations = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>();
  const headers = new Map<string, ReturnType<PluginClientContext["addHeaderButton"]>>();
  let disposed = false, polling = false;
  const openAgent: OpenAgent = (workspaceId, agentId) => {
    requests.set(workspaceId, { status: "created", requestId: `navigation-${agentId}`, goal: "", agentId });
    client.openPanel("director", { workspaceId });
  };
  const poll = async () => {
    if (disposed || polling) return; polling = true;
    try {
      const chats = await client.rpc(listConversationsRpc, {});
      if (disposed) return;
      const live = new Set<string>();
      for (const c of chats) {
        if (!c.agentId) continue;
        live.add(c.agentId);
        if (!headers.has(c.workspaceId)) headers.set(c.workspaceId, client.addHeaderButton({ id: "director-settings", workspaceId: c.workspaceId,
          button: { title: "协作设置", icon: "Settings", behavior: { kind: "action", onPress: () => client.openSettings("director-settings") } } }));
        const label = c.error ? "协作需要处理" : c.activity?.control === "waiting_permission" ? "等待权限" : c.activity?.control === "needs_attention" ? "协作受阻" : c.activity?.running ? "1 个运行中" : c.activity?.phase === "awaiting_acceptance" ? "等待验收" : `子 Agent · ${c.activity?.total ?? 0}`;
        const button = { title: "子 Agent", label, icon: "Workflow", behavior: { kind: "popover" as const, Content: ({ theme, host }: { theme: Theme; host: { id: string } }) => <ChildPopover hostId={host.id} id={c.id} theme={theme} openAgent={openAgent} /> } };
        const previous = registrations.get(c.agentId);
        if (previous) previous.update({ title: button.title, label });
        else registrations.set(c.agentId, client.addComposerPill({ id: "director-children", workspaceId: c.workspaceId, agentId: c.agentId, button }));
      }
      for (const [id, registration] of registrations) if (!live.has(id)) { registration.remove(); registrations.delete(id); }
    } catch (error) { console.warn("Director controls:", error instanceof Error ? error.message : String(error)); }
    finally { polling = false; }
  };
  const renderer = client.addTimelineRenderer({ kind: "director-conversation", version: 1, schema: ConversationLinkSchema, Component: createConversationRenderer(openAgent) });
  void poll(); const timer = setInterval(() => { void poll(); }, 2500);
  return () => { disposed = true; clearInterval(timer); renderer(); for (const r of registrations.values()) r.remove(); for (const r of headers.values()) r.remove(); };
}
