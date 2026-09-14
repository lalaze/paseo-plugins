import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { useRpc, useWorkspace, type PluginSurfaceProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getSettingsRpc, openConversationRpc } from "../shared/rpc";
import { SettingsEditor } from "./settings";
import { Button, Card, ErrorText, Label } from "./ui";
import type { LaunchRequests } from "./launch";

export function DirectorSurface({ host, theme, layout }: PluginSurfaceProps) {
  const get = useRpc(getSettingsRpc);
  const settings = useQuery({ queryKey: ["director", host.id, "settings"], queryFn: () => get({}) });
  const [saved, setSaved] = useState(false);
  return <View style={{ flex: 1, padding: layout.compact ? 12 : 24, gap: 12 }}>
    {saved && <Label theme={theme}>协作设置已保存，用于之后新建的主对话。</Label>}
    <ErrorText theme={theme} error={settings.error ?? settings.data?.error} />
    <SettingsEditor hostId={host.id} initial={settings.data?.settings ?? null} cwd="" theme={theme} compact={layout.compact} onSaved={() => { setSaved(true); void settings.refetch(); }} />
  </View>;
}

// Paseo 0.8 exposes native navigation on surface props, not slash commands or
// composer popovers. This small bridge navigates once; it is not a task panel.
export function DirectorPanel(props: PluginWorkspacePanelProps & { requests: LaunchRequests }) {
  const { workspaceId, host, navigation, theme, layout, requests } = props;
  const directory = useWorkspace(workspaceId, w => w.directory);
  const launch = useSyncExternalStore(requests.subscribe, () => requests.get(workspaceId), () => null);
  const open = useRpc(openConversationRpc), get = useRpc(getSettingsRpc);
  const settings = useQuery({ queryKey: ["director", host.id, "settings"], queryFn: () => get({}) });
  const requestId = useRef(`open-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const redirected = useRef<string | null>(null);
  const create = useMutation({ mutationFn: open });
  const [configured, setConfigured] = useState(false);
  const needsSetup = !configured && (launch?.status === "setup" || settings.data?.settings === null);
  useEffect(() => {
    if (!needsSetup && !launch && settings.data?.settings && !create.isPending && !create.data && !create.error)
      create.mutate({ requestId: requestId.current, workspaceId });
  }, [needsSetup, launch, settings.data, workspaceId, create.isPending, create.data, create.error]);
  const agentId = launch?.agentId ?? create.data?.agentId;
  useEffect(() => {
    if (agentId && navigation && redirected.current !== agentId) { redirected.current = agentId; navigation.openAgent({ agentId }); }
  }, [agentId, navigation]);
  const resume = () => create.mutate({ requestId: launch?.requestId ?? requestId.current, workspaceId, goal: launch?.goal || undefined, fresh: !!launch?.goal });
  if (needsSetup) return <View style={{ flex: 1, padding: layout.compact ? 12 : 24, gap: 12 }}>
    <Label theme={theme}>先保存主 Agent、执行和审核设置。主 Agent 需要支持 MCP 工具，任务描述已保留。</Label>
    <SettingsEditor hostId={host.id} initial={settings.data?.settings ?? null} cwd={directory ?? ""} compact={layout.compact} theme={theme} onSaved={() => { setConfigured(true); void settings.refetch(); resume(); }} />
  </View>;
  return <View style={{ padding: 24 }}><Card theme={theme} title={agentId ? "主对话已准备好" : "正在打开主对话"}>
    <ErrorText theme={theme} error={create.error ?? settings.error ?? settings.data?.error ?? (launch?.status === "failed" ? launch.message : undefined)} />
    {agentId && navigation ? <Button theme={theme} label="进入主对话" onPress={() => navigation.openAgent({ agentId })} />
      : agentId ? <Label theme={theme}>当前客户端不支持直接跳转，请在工作区会话列表打开“主 Agent”。</Label>
      : <Button theme={theme} secondary label="重新打开" disabled={create.isPending || launch?.status === "submitting"} onPress={resume} />}
  </Card></View>;
}
