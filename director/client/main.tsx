import { useCallback, useEffect, useState, useRef, useSyncExternalStore } from "react";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { usePaseo, useRpc, useWorkspace, type PluginSurfaceProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRunRpc, getSettingsRpc, listRunsRpc, getWorkspaceRunRpc } from "../shared/rpc";
import { SettingsEditor } from "./settings";
import { RunDetail } from "./run-detail";
import { createRunHint, runStatus } from "./run-model";
import { StatusBadge } from "./run-progress";
import { Button, Card, Choice, ErrorText, Field, Label, outline } from "./ui";
import type { LaunchRequest, LaunchRequests } from "./launch";
import { Disclosure, SelectionCard } from "./settings-controls";
import { listLaunchWorkspaces } from "./workspaces";

const noSubscription = () => () => {};
export function DirectorPanel(props: PluginWorkspacePanelProps & { requests?: LaunchRequests }) {
  const directory = useWorkspace(props.workspaceId, workspace => workspace.directory);
  const launch = useSyncExternalStore(props.requests?.subscribe ?? noSubscription, () => props.requests?.get(props.workspaceId) ?? null, () => null);
  return <DirectorSurface key={`${props.host.id}:${props.workspaceId}`} {...props} initialDirectory={directory ?? ""} workspaceId={props.workspaceId} launch={launch} />;
}
export function DirectorSurface({ theme, layout, navigation, host, initialDirectory = "", workspaceId, launch }: PluginSurfaceProps & { initialDirectory?: string; workspaceId?: string; launch?: LaunchRequest | null }) {
  return <DirectorContent key={`${host.id}:${workspaceId ?? "global"}`} {...{ theme, layout, navigation, host, initialDirectory, workspaceId, launch }} />;
}
function DirectorContent({ theme, layout, navigation, host, initialDirectory = "", workspaceId, launch }: PluginSurfaceProps & { initialDirectory?: string; workspaceId?: string; launch?: LaunchRequest | null }) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const getSettings = useRpc(getSettingsRpc), listRuns = useRpc(listRunsRpc), createRun = useRpc(createRunRpc), getWorkspaceRun = useRpc(getWorkspaceRunRpc);
  const [page, setPage] = useState<"restore" | "tasks" | "create" | "settings">("restore");
  const [repository, setRepository] = useState(initialDirectory), [goal, setGoal] = useState("");
  const [isolated, setIsolated] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null), [offset, setOffset] = useState(0);
  const [launchMessage, setLaunchMessage] = useState<LaunchRequest | null>(null);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const settingsReturn = useRef<{ page: "tasks" | "create"; selectedId: string | null }>({ page: "create", selectedId: null });
  const [notice, setNotice] = useState("");
  const requestKey = useRef<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const resetScroll = useCallback(() => scroll.current?.scrollTo({ y: 0, animated: false }), []);
  const settingsQuery = useQuery({ queryKey: ["director", host.id, "settings"], queryFn: () => getSettings({}) });
  const settings = settingsQuery.data?.settings ?? null;
  const workspaces = useQuery({ queryKey: ["director", "workspaces", host.id], queryFn: () => listLaunchWorkspaces(paseo.workspaces), enabled: !workspaceId && !isolated });
  const selectedWorkspace = workspaces.data?.find(workspace => workspace.id === selectedWorkspaceId);
  const targetWorkspaceId = isolated ? undefined : workspaceId ?? selectedWorkspace?.id;
  const targetDirectory = isolated ? repository : workspaceId ? initialDirectory : selectedWorkspace?.directory ?? "";
  const runs = useQuery({ queryKey: ["director", host.id, "runs", offset], queryFn: () => listRuns({ offset, limit: 20 }), refetchInterval: 4000, enabled: page === "tasks" });
  const workspaceRun = useQuery({ queryKey: ["director", "workspace-run", host.id, workspaceId], queryFn: () => getWorkspaceRun({ workspaceId: workspaceId! }), enabled: !!workspaceId && page === "restore" && !launch, staleTime: 0 });
  useEffect(() => {
    if (page !== "restore" || launch) return;
    if (!workspaceId) { setPage("tasks"); return; }
    // Wait for a fresh lookup after a remount, even if the query cache survives.
    if (!workspaceRun.isFetchedAfterMount || workspaceRun.isError || !workspaceRun.data) return;
    setSelectedId(workspaceRun.data.id); setPage(workspaceRun.data.id ? "tasks" : "create");
    resetScroll();
  }, [page, launch, workspaceId, workspaceRun.isFetchedAfterMount, workspaceRun.isError, workspaceRun.data, resetScroll]);
  const showSettings = !selectedId && (page === "settings" || (page === "create" && !settings && !settingsQuery.isPending && !settingsQuery.isError));
  useEffect(() => { if (showSettings && !settingsQuery.isPending && !settingsQuery.isError) setSettingsMounted(true); }, [showSettings, settingsQuery.isPending, settingsQuery.isError]);
  useEffect(() => { if (initialDirectory) setRepository(initialDirectory); }, [initialDirectory]);
  useEffect(() => {
    if (!launch) return;
    setGoal(launch.status === "created" ? "" : launch.goal); setLaunchMessage(launch);
    setSelectedId(launch.runId ?? null); setPage(launch.status === "setup" ? "settings" : launch.status === "created" ? "tasks" : "create");
    settingsReturn.current = { page: "create", selectedId: null };
    setNotice("");
    requestKey.current = launch.status === "created" ? null : launch.requestId;
    if (launch.status === "created") { void runs.refetch(); }
    resetScroll();
  }, [launch, resetScroll]);
  const create = useMutation({ mutationFn: createRun, onSuccess: result => { requestKey.current = null; setGoal(""); setLaunchMessage(null); setNotice(""); setOffset(0); setSelectedId(result.id); setPage("tasks"); resetScroll(); void runs.refetch(); } });
  const busy = create.isPending || launchMessage?.status === "submitting";
  const createHint = createRunHint({ goal, directory: targetDirectory, needsWorkspace: !isolated && !targetWorkspaceId });
  function navigate(next: "tasks" | "create" | "settings") {
    if (next === "settings" && page !== "settings") settingsReturn.current = { page: page === "create" ? "create" : "tasks", selectedId };
    setSelectedId(null); setPage(next); setNotice(""); resetScroll();
  }
  function editDraft() { requestKey.current = null; create.reset(); setLaunchMessage(null); setNotice(""); }
  function start() {
    if (!settings || createHint || busy) return;
    setLaunchMessage(null);
    requestKey.current ??= `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    create.mutate({ repository: targetDirectory.trim(), goal: goal.trim(), settings, requestId: requestKey.current, ...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}) });
  }
  const showCreateActions = !selectedId && page === "create" && !showSettings && !!settings && !settingsQuery.isError;
  return <KeyboardAvoidingView behavior={layout.platform === "ios" ? "padding" : undefined} style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
    <View style={{ padding: layout.compact ? 12 : 24, maxWidth: 1100, width: "100%", alignSelf: "center", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 26, fontWeight: "700" }}>Director</Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}><Button theme={theme} secondary selected={page === "tasks" && !selectedId} disabled={busy || settingsSaving} label="任务记录" onPress={() => navigate("tasks")} /><Button theme={theme} secondary selected={page === "create" && !showSettings} disabled={busy || settingsSaving} label="新建任务" onPress={() => navigate("create")} /><Button theme={theme} secondary selected={showSettings} disabled={busy || settingsSaving} label="协作设置" onPress={() => navigate("settings")} /></View>
    </View>
    {!!notice && <View accessibilityLiveRegion="polite"><Label theme={theme}>{notice}</Label></View>}
    <ErrorText theme={theme} error={settingsQuery.data?.error} />
    {launchMessage?.status === "submitting" && <Card theme={theme} title="正在下发协作任务"><Label theme={theme}>正在使用当前项目和已保存的 AI 分工创建任务…</Label></Card>}
    {launchMessage?.status === "setup" && <Label theme={theme}>{launchMessage.message}</Label>}
    {launchMessage?.status === "failed" && <ErrorText theme={theme} error={launchMessage.message} />}
    {(settingsMounted || (showSettings && !settingsQuery.isPending && !settingsQuery.isError)) && <View style={{ display: showSettings ? "flex" : "none", flex: 1, minHeight: 0 }}>
      <SettingsEditor hostId={host.id} initial={settings} cwd={targetDirectory || repository} compact={layout.compact} theme={theme} onSavingChange={setSettingsSaving} onSaved={s => {
        queryClient.setQueryData(["director", host.id, "settings"], { settings: s, error: settingsQuery.data?.error ?? null });
        setSettingsMounted(false); setLaunchMessage(null); setNotice("协作设置已保存，用于之后新建的任务。");
        setPage(settingsReturn.current.page); setSelectedId(settingsReturn.current.selectedId); resetScroll(); void settingsQuery.refetch();
      }} />
    </View>}
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" style={{ flex: 1, display: showSettings && (settingsMounted || (!settingsQuery.isPending && !settingsQuery.isError)) ? "none" : "flex" }} contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: 16, maxWidth: 1100, width: "100%", alignSelf: "center" }}>
    {selectedId ? <><Button theme={theme} secondary label="返回任务记录" onPress={() => navigate("tasks")} /><RunDetail key={selectedId} id={selectedId} hostId={host.id} theme={theme} navigation={navigation} /></> : page === "restore" ? <Card theme={theme} title="正在恢复当前工作区的任务">
      <Label theme={theme}>读取已保存的任务进度…</Label>
      <ErrorText theme={theme} error={workspaceRun.error} />
      {workspaceRun.isError && <Button theme={theme} secondary label="重新读取任务" disabled={workspaceRun.isFetching} onPress={() => { void workspaceRun.refetch(); }} />}
    </Card> : settingsQuery.isPending && (page === "settings" || page === "create") ? <Label theme={theme} muted>正在读取协作设置…</Label> : settingsQuery.isError && (page === "settings" || page === "create") ? <Card theme={theme} title="暂时无法读取协作设置"><ErrorText theme={theme} error={settingsQuery.error} /><Button theme={theme} secondary label="重新读取设置" disabled={settingsQuery.isFetching} onPress={() => { void settingsQuery.refetch(); }} /></Card> : showSettings ? null : <>
      {page === "create" && <Card theme={theme} title="创建协作任务">
        <Field theme={theme} disabled={busy} label="目标与验收要求" value={goal} onChange={s => { setGoal(s); editDraft(); }} multiline placeholder={"要完成什么？\n有哪些限制或需要保留的行为？\n怎样才算完成？"} />
        <Label theme={theme} muted>{goal.trim().length} / 32000 个字符</Label>
        <Label theme={theme}>{isolated ? "来源仓库" : "当前项目"}：{targetDirectory || "请选择工作区"}</Label>
        <Disclosure theme={theme} title="执行位置" summary={isolated ? "新建独立工作区 · 原工作区保留当前分支" : "在工作区新建成果分支 · 已有会话会看到修改"} defaultOpen={!workspaceId}>
        <View accessibilityRole="radiogroup" accessibilityLabel="执行位置" style={{ gap: 8 }}>
          <SelectionCard role="radio" theme={theme} disabled={busy} title={workspaceId ? "在当前工作区执行" : "使用已有工作区"} description="在选定工作区新建成果分支，所有 AI 会话放在一起。已有会话也会看到代码修改。" selected={!isolated} onPress={() => { setIsolated(false); editDraft(); }} />
          <SelectionCard role="radio" theme={theme} disabled={busy} title="新建独立工作区" description="创建独立代码目录，并在侧栏新增工作区条目。原工作区保留当前分支。" selected={isolated} onPress={() => { setIsolated(true); editDraft(); }} />
        </View>
        {!workspaceId && !isolated && <>
          <ErrorText theme={theme} error={workspaces.error} />
          {workspaces.isPending ? <Label theme={theme} muted>正在读取已有工作区…</Label> : <Choice theme={theme} disabled={busy} label="在哪个工作区执行？" value={selectedWorkspaceId} options={[{ id: "", label: "请选择已有工作区" }, ...(workspaces.data ?? []).map(workspace => ({ id: workspace.id, label: `${workspace.name} · ${workspace.directory}` }))]} onChange={id => { setSelectedWorkspaceId(id); const workspace = workspaces.data?.find(entry => entry.id === id); if (workspace) setRepository(workspace.directory); editDraft(); }} />}
          {!workspaces.isPending && workspaces.data?.length === 0 && <Label theme={theme} muted>当前主机还没有可用的 Git 工作区。先在 Paseo 打开项目，再刷新列表。</Label>}
          {selectedWorkspaceId && !selectedWorkspace && !workspaces.isPending && <Label theme={theme} muted>所选工作区已不可用，请重新选择。</Label>}
          <Button theme={theme} secondary label="刷新工作区列表" disabled={workspaces.isFetching} onPress={() => { void workspaces.refetch(); }} />
        </>}
        {isolated && <Field theme={theme} disabled={busy} label="项目仓库路径" value={repository} onChange={s => { setRepository(s); editDraft(); }} placeholder="主机上的绝对路径" />}
        </Disclosure>
        {settings && <Disclosure theme={theme} title="本次 AI 团队" summary={`设计：${settings.profiles.find(p => p.id === settings.directorProfileId)?.label} · 执行：${settings.profiles.find(p => p.id === settings.workerProfileId)?.label} · 审核：${settings.profiles.find(p => p.id === (settings.reviewerProfileId ?? settings.directorProfileId))?.label}`}>
          <Label theme={theme}>设计制定总纲 → 执行实现 → 审核检查 → 你验收</Label>
          <Label theme={theme} muted>{settings.reviewerProfileId ? "审核使用独立会话" : "审核沿用设计会话"} · {Object.keys(settings.categoryOverrides).length + Object.keys(settings.taskOverrides).length} 条执行分配规则</Label>
          <Button theme={theme} secondary disabled={busy} label="调整团队设置" onPress={() => navigate("settings")} />
        </Disclosure>}
        {!isolated && <Label theme={theme} muted>开始前请提交或暂存当前目录的未提交改动。</Label>}
      </Card>}
      {page === "tasks" && <Card theme={theme} title="任务记录">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}><Label theme={theme} muted>当前主机的全部任务 · 最新创建在前</Label><Button theme={theme} secondary label={runs.isFetching ? "刷新中…" : "刷新记录"} disabled={runs.isFetching} onPress={() => { void runs.refetch(); }} /></View>
        <ErrorText theme={theme} error={runs.error ?? runs.data?.error} />
        {runs.isPending && <Label theme={theme}>正在读取…</Label>}
        {runs.data?.runs.length === 0 && <><Label theme={theme} muted>{offset ? "这一页没有任务，请返回上一页。" : "还没有协作任务。写下目标，安排 AI 团队开始工作。"}</Label>{!offset && <Button theme={theme} label="创建第一个任务" onPress={() => navigate("create")} />}</>}
        {runs.data?.runs.map(run => <View key={run.id} style={{ gap: 9, borderBottomWidth: 1, borderColor: outline(theme, "panel"), paddingVertical: 12 }}>
          <StatusBadge theme={theme} {...runStatus(run)} />
          <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 16, lineHeight: 24, fontWeight: "600" }}>{run.goal}</Text>
          <Label theme={theme} muted>代码目录：{run.cwd}{"\n"}更新于 {new Date(run.updatedAt).toLocaleString()} · {run.total ? `子任务已通过 ${run.done} / ${run.total}` : "尚未生成子任务"}</Label>
          <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 21 }}>{run.message}</Text>
          <Button theme={theme} secondary label="查看任务" onPress={() => { setSelectedId(run.id); resetScroll(); }} />
        </View>)}
        {(offset > 0 || runs.data?.hasMore) && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}><Button theme={theme} secondary label="上一页" disabled={!offset || runs.isFetching} onPress={() => { setOffset(n => Math.max(0, n - 20)); resetScroll(); }} /><Label theme={theme} muted>第 {Math.floor(offset / 20) + 1} 页</Label><Button theme={theme} secondary label="下一页" disabled={!runs.data?.hasMore || runs.isFetching} onPress={() => { setOffset(n => n + 20); resetScroll(); }} /></View>}
      </Card>}
    </>}
    </ScrollView>
    {showCreateActions && <View style={{ backgroundColor: theme.colors.surface1, borderTopWidth: 1, borderColor: outline(theme, "panel") }}>
      <View style={{ padding: layout.compact ? 12 : 16, gap: 8, maxWidth: 1100, width: "100%", alignSelf: "center" }}>
        <ErrorText theme={theme} error={create.error} />
        {create.error && <Label theme={theme} muted>目标和执行位置已保留，处理原因后重试即可。</Label>}
        {createHint && !busy && <Label theme={theme} muted>{createHint}</Label>}
        <Button theme={theme} label={busy ? "正在创建…" : create.isError ? "重试创建任务" : "开始设计与执行"} disabled={!!createHint || busy} onPress={start} />
      </View>
    </View>}
  </KeyboardAvoidingView>;
}
