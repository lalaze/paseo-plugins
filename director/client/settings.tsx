import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ProfileSchema, type Profile, type Settings } from "../shared/schema";
import { instructionRoles, type InstructionRole } from "../shared/instructions";
import { commitSettingsRpc, getSettingsRpc, getSettingsDraftRpc, writeSettingsDraftRpc } from "../shared/rpc";
import { documentKey, settingsForm, type DraftState, type SettingsDraft, type SettingsForm } from "../shared/settings-draft";
import { createDraftWriter } from "./draft-writer";
import { Button, Card, Choice, ErrorText, Field, Label, outline, type Theme } from "./ui";
import { Disclosure, ProfileEditor, SelectionCard } from "./settings-controls";
import { checkPresets, commandLine, makeCheck, makeAssignment, profileParts, sameCommand, savedRolePrompts, taskCategories, validateSettings } from "./settings-model";
import { InstructionsEditor } from "./instructions-editor";
import { permissionChoices } from "./permission-model";
import { ui } from "./i18n";

const steps = [ui("Choose lead agent", "选择主 Agent"), ui("Choose implementation AI", "选择执行 AI"), ui("Choose review AI", "选择审核 AI")];
const localizedInstructionRoles: typeof instructionRoles = {
  plan: { label: ui("Planning AI", "设计 AI"), description: ui(instructionRoles.plan.description, "制定总纲或根据修改意见重新设计时使用。"), example: ui(instructionRoles.plan.example, "先阅读项目说明和现有实现，再制定可执行的方案。优先复用已有结构，写清修改范围、接口、依赖关系和验收标准。按用户配置的任务类型拆分工作，只制定方案，不直接修改源代码。") },
  execute: { label: ui("Implementation AI", "执行 AI"), description: ui(instructionRoles.execute.description, "所有执行者在实现、返工和追加修改时使用，包括按类型指定的 AI。"), example: ui(instructionRoles.execute.example, "动手前阅读相关代码和项目约定，优先复用现有实现。围绕当前任务做必要修改，保留已有功能与用户改动。完成后运行与改动相关的验证，说明改了什么、实际验证结果和仍有的问题。不要修改测试来掩盖失败；遇到真实阻碍时说明原因。") },
  review: { label: ui("Review AI", "审核 AI"), description: ui(instructionRoles.review.description, "全部任务完成后的统一审核与返工复审时使用；沿用设计会话也会应用。"), example: ui(instructionRoles.review.example, "逐项对照验收标准，独立检查实际代码、差异和执行报告，按需运行测试或构建。重点检查功能遗漏、边界情况、回归风险和验证证据。问题需注明位置、具体修改要求及复验方法；只审核，不修改源代码。通过时写清依据，未验证的部分如实说明，不把推测当成已通过。") },
};
const newId = () => `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DRAFT_WRITE_DELAY_MS = 400;

type EditorProps = { initial: Settings | null; cwd: string; hostId: string; theme: Theme; compact?: boolean; onSaved: (s: Settings) => void; onSavingChange?: (saving: boolean) => void };
export function SettingsEditor(props: EditorProps) {
  const getDraft = useRpc(getSettingsDraftRpc), getSettings = useRpc(getSettingsRpc);
  const query = useQuery({ queryKey: ["director", props.hostId, "settings-editor"], queryFn: async () => {
    const [seed, settings] = await Promise.all([getDraft({}), getSettings({})]); return { seed, initial: settings.settings };
  }, refetchOnWindowFocus: false });
  if (query.isError || !query.isFetchedAfterMount || !query.data) return <Card theme={props.theme} title={ui("Loading collaboration settings and draft", "读取协作设置与草稿")}>
    <Label theme={props.theme} muted>{query.isError ? ui("Unable to load. Check the host connection.", "暂时无法读取，请检查主机连接。") : ui("Restoring your previous edits…", "正在恢复上次编辑的内容…")}</Label>
    <ErrorText theme={props.theme} error={query.error} />
    {query.isError && <Button theme={props.theme} secondary label={ui("Reload settings", "重新读取设置")} onPress={() => { void query.refetch(); }} />}
  </Card>;
  return <SettingsFormEditor key={query.dataUpdatedAt} {...props} {...query.data} onReload={async () => { await query.refetch(); }} />;
}

function SettingsFormEditor({ initial: loadedInitial, seed, cwd, hostId, theme, compact = false, onSaved, onSavingChange, onReload }: EditorProps & { seed: DraftState; onReload: () => Promise<void> }) {
  const paseo = usePaseo();
  const [initial, setInitial] = useState(loadedInitial);
  const [base, setBase] = useState(seed.draft ? seed.draft.base : initial);
  const [restoredDraft, setRestoredDraft] = useState(!!seed.draft);
  const [form, setForm] = useState(() => seed.draft?.form ?? settingsForm(initial));
  const lockedRef = useRef(false);
  function field<K extends keyof SettingsForm>(key: K): [SettingsForm[K], Dispatch<SetStateAction<SettingsForm[K]>>] {
    return [form[key], value => { if (!lockedRef.current) setForm(old => ({ ...old, [key]: typeof value === "function" ? value(old[key]) : value })); }];
  }
  const [step, setStep] = field("step"), [profiles, setProfiles] = field("profiles");
  const [director, setDirector] = field("director"), [worker, setWorker] = field("worker"), [reviewer, setReviewer] = field("reviewer");
  const [separateReview, setSeparateReview] = field("separateReview"), [rolePrompts, setRolePrompts] = field("rolePrompts");
  const [overrides, setOverrides] = field("overrides"), [taskOverrides, setTaskOverrides] = field("taskOverrides");
  const [ruleKind, setRuleKind] = field("ruleKind"), [ruleKey, setRuleKey] = field("ruleKey"), [ruleProfile, setRuleProfile] = field("ruleProfile");
  const [extraProfile, setExtraProfile] = field("extraProfile"), [checks, setChecks] = field("checks");
  const [showCommand, setShowCommand] = field("showCommand"), [editingCheck, setEditingCheck] = field("editingCheck");
  const [checkLabel, setCheckLabel] = field("checkLabel"), [checkLine, setCheckLine] = field("checkLine"), [checkMinutes, setCheckMinutes] = field("checkMinutes");
  const [maxReworks, setMaxReworks] = field("maxReworks"), [turnMinutes, setTurnMinutes] = field("turnMinutes");
  const [maxAttempts, setMaxAttempts] = field("maxAttempts"), [runHours, setRunHours] = field("runHours");
  const [approval, setApproval] = field("approval"), [allowSelection, setAllowSelection] = field("allowSelection");
  const [error, setError] = useState<unknown>(null);
  const [confirmReset, setConfirmReset] = useState(false), [resetting, setResetting] = useState(false);
  const scroll = useRef<ScrollView>(null);
  useEffect(() => { scroll.current?.scrollTo({ y: 0, animated: false }); }, [step]);
  const mounted = useRef(true), edited = useRef(!!seed.draft);
  const [, redraw] = useState(0);
  const writeDraft = useRpc(writeSettingsDraftRpc);
  const [writer] = useState(() => createDraftWriter(seed.revision, writeDraft, () => { if (mounted.current) redraw(n => n + 1); }));
  // An edit still waiting for its debounce is flushed when the editor unmounts.
  const pendingDraft = useRef<{ draft: SettingsDraft | null } | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (pendingDraft.current) { writer.enqueue(pendingDraft.current.draft); pendingDraft.current = undefined; } }; }, []);
  // Serializing the form is the expensive part of a render: instructions alone
  // can reach hundreds of kilobytes. Baselines change only on save or reload.
  const baseKey = useMemo(() => documentKey(settingsForm(base)), [base]);
  const stale = useMemo(() => documentKey(base) !== documentKey(initial), [base, initial]);
  const formKey = useMemo(() => documentKey({ ...form, step: 0 }), [form]);
  const dirty = formKey !== baseKey;
  const previousForm = useRef(formKey);
  useEffect(() => {
    if (previousForm.current === formKey) return;
    previousForm.current = formKey;
    if (!dirty && !edited.current) return;
    edited.current = true;
    // Coalesce keystrokes into one draft write; the latest edit always wins.
    pendingDraft.current = { draft: dirty ? { version: 1, base, form } : null };
    const timer = setTimeout(() => { if (pendingDraft.current) { writer.enqueue(pendingDraft.current.draft); pendingDraft.current = undefined; } }, DRAFT_WRITE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [formKey]);
  const catalog = useQuery({ queryKey: ["director", hostId, "providers", cwd], queryFn: () => paseo.providers.waitForReady({ cwd: cwd || undefined, timeoutMs: 12000 }), staleTime: 30000 });
  const save = useRpc(commitSettingsRpc);
  const mutation = useMutation({ mutationFn: async (settings: Settings) => {
    return writer.commit(draftRevision => save({ settings, base, draftRevision }));
  }, onSuccess: (_, value) => {
    // The commit clears the draft and advances its revision. Start a clean editing
    // baseline while retaining the tab the user saved from.
    const nextForm = { ...settingsForm(value), step: form.step };
    previousForm.current = documentKey({ ...nextForm, step: 0 });
    pendingDraft.current = undefined;
    edited.current = false;
    setInitial(value); setBase(value); setForm(nextForm); setRestoredDraft(false);
    onSaved(value);
  } });
  const locked = mutation.isPending || resetting;
  lockedRef.current = locked;
  useEffect(() => { onSavingChange?.(locked); return () => onSavingChange?.(false); }, [locked, onSavingChange]);
  const lead = profiles.find(p => p.id === director), executor = profiles.find(p => p.id === worker), auditor = profiles.find(p => p.id === reviewer);
  const choices = profiles.filter(p => ProfileSchema.safeParse(p).success).map(p => ({ id: p.id, label: `${p.label} · ${p.provider}` }));
  const assignedCount = Object.keys(overrides).length + Object.keys(taskOverrides).length;
  const readyCount = catalog.data?.entries.filter(e => e.status === "ready").length ?? 0;

  function updateRole(role: "director" | "worker" | "reviewer", patch: Partial<Profile>) {
    const current = { director: lead, worker: executor, reviewer: auditor }[role];
    const bindings = { director, worker, reviewer };
    const shared = current && [...Object.entries(bindings).filter(([key]) => key !== role).map(([, id]) => id), ...Object.values(overrides), ...Object.values(taskOverrides)].includes(current.id);
    const profile = { ...current, id: !current || shared ? newId() : current.id, label: !shared && current?.label ? current.label : { director: ui("Planning AI", "设计 AI"), worker: ui("Implementation AI", "执行 AI"), reviewer: ui("Review AI", "审核 AI") }[role], provider: current?.provider ?? "", transport: current?.transport ?? "structured", ...patch } as Profile;
    setProfiles(ps => [...ps.filter(p => p.id !== profile.id), profile]);
    ({ director: setDirector, worker: setWorker, reviewer: setReviewer })[role](profile.id);
    setError(null);
  }
  function roleError(profile: Profile | undefined, name: string) {
    const parts = profileParts(profile);
    if (!parts.provider || !parts.model) return ui(`Choose a provider and model for ${name}.`, `请先为${name}选择供应商和模型。`);
    if ((profile?.instructions?.length ?? 0) > 8000) return ui(`${name}'s additional instructions are limited to 8000 characters.`, `${name}的补充提示词最多 8000 个字符。`);
    if (!ProfileSchema.safeParse(profile).success) return ui(`Check ${name}'s name and model settings. Names must be 1–120 characters.`, `请检查${name}的 AI 昵称和模型设置；昵称需为 1 至 120 个字符。`);
    if (permissionChoices(catalog.data?.entries.find(entry => entry.provider === parts.provider), profile?.modeId).unavailable) return ui(`${name}'s permission mode is unavailable. Choose another permission mode.`, `${name}的权限模式当前不可用，请重新选择执行权限。`);
    return null;
  }
  function move(next: number) { setStep(next); setError(null); mutation.reset(); }
  function next() {
    const message = step === 0 ? roleError(lead, ui("planning AI", "设计 AI")) : roleError(executor, ui("implementation AI", "执行 AI"));
    if (message) { setError(new Error(message)); return; }
    const role = step === 0 ? "plan" : "execute";
    if ((rolePrompts[role]?.length ?? 0) > 8000) { const label = localizedInstructionRoles[role].label; setError(new Error(ui(`${label} instructions are limited to 8000 characters.`, `${label}前置提示词最多 8000 个字符。`))); return; }
    move(step + 1);
  }
  function resetCommand() {
    setShowCommand(false); setEditingCheck(null); setCheckLine(""); setCheckLabel(""); setCheckMinutes("2"); setError(null);
  }
  function addCheck() {
    try {
      const check = makeCheck(checkLine, checkLabel, checkMinutes);
      if (checks.some((c, i) => i !== editingCheck && sameCommand(c, check))) throw new Error(ui("This check has already been added. Each command only needs to be added once.", "这条检查已经添加了。每条命令只需添加一次。"));
      if (editingCheck === null && checks.length >= 12) throw new Error(ui("You can add up to 12 checks. Remove an unused check first.", "最多添加 12 项检查，请先移除不需要的检查。"));
      setChecks(cs => editingCheck === null ? [...cs, check] : cs.map((c, i) => i === editingCheck ? check : c));
      resetCommand();
    } catch (e) { setError(e); }
  }
  function saveAll() {
    try {
      const leadError = roleError(lead, ui("planning AI", "设计 AI")), workerError = roleError(executor, ui("implementation AI", "执行 AI")), reviewerError = separateReview ? roleError(auditor, ui("review AI", "审核 AI")) : null;
      if (leadError) { move(0); throw new Error(leadError); }
      if (workerError) { move(1); throw new Error(workerError); }
      if (reviewerError) { move(2); throw new Error(reviewerError); }
      for (const [index, role] of (["plan", "execute", "review"] as const).entries()) {
        if ((rolePrompts[role]?.length ?? 0) > 8000) { move(index); const label = localizedInstructionRoles[role].label; throw new Error(ui(`${label} instructions are limited to 8000 characters.`, `${label}前置提示词最多 8000 个字符。`)); }
      }
      if (extraProfile) { move(1); throw new Error(ui("An AI profile is still being edited. Expand “Manage other AIs” to apply or cancel it.", "还有一个 AI 正在编辑，请展开“管理其他 AI”应用或取消编辑。")); }
      if (ruleProfile && ruleKey.trim()) { move(1); throw new Error(ui("An assignment rule has not been added. Expand “Assign different AIs by task” to add or cancel it.", "还有一条分配规则未添加，请展开“按任务分配不同 AI”添加或取消。")); }
      if (showCommand && (checkLine.trim() || editingCheck !== null)) { move(2); throw new Error(ui("Select “Add this check” or “Update check” first, or cancel editing.", "请先点击“添加这项检查”或“更新检查”，也可以取消编辑。")); }
      const referenced = new Set([director, worker, ...(separateReview ? [reviewer] : []), ...Object.values(overrides), ...Object.values(taskOverrides)]);
      const savedProfiles = profiles.filter(p => referenced.has(p.id) || initial?.profiles.some(old => old.id === p.id) || ProfileSchema.safeParse(p).success);
      const settings = validateSettings({ ...initial, profiles: savedProfiles, directorProfileId: director, workerProfileId: worker, reviewerProfileId: separateReview ? reviewer : undefined, rolePrompts: savedRolePrompts(rolePrompts), categoryOverrides: overrides, taskOverrides, verificationCommands: checks, maxReworks: Number(maxReworks), turnTimeoutMs: Number(turnMinutes) * 60000, maxAttempts: Number(maxAttempts), runTimeoutMs: Number(runHours) * 3600000, requirePlanApproval: approval, allowDirectorSelection: allowSelection });
      setError(null); mutation.mutate(settings);
    } catch (e) { setError(e); }
  }
  const profileSummary = (profile?: Profile) => profileParts(profile).model ? profile!.provider : ui("Not selected", "尚未选择");
  function rolePrompt(role: InstructionRole) {
    const info = localizedInstructionRoles[role];
    return <InstructionsEditor theme={theme} label={ui(`${info.label} instructions`, `${info.label}前置提示词`)} description={info.description} example={info.example} value={rolePrompts[role] ?? ""} onChange={value => { setRolePrompts(prompts => ({ ...prompts, [role]: value })); setError(null); }} />;
  }

  async function discard() {
    setResetting(true);
    try { writer.enqueue(null); await writer.flush(); await onReload(); }
    catch (e) { setError(e); }
    finally { setResetting(false); setConfirmReset(false); }
  }
  return <View style={{ flex: 1, minHeight: 0 }}>
    <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: compact ? 12 : 24, gap: 16, maxWidth: 1100, width: "100%", alignSelf: "center" }}>
    <View pointerEvents={locked ? "none" : "auto"} style={{ gap: 16, opacity: locked ? 0.65 : 1 }}>
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>{ui("Arrange your AI team", "安排你的 AI 团队")}</Text>
      <Label theme={theme} muted>{ui("Switch roles at any time. Saved settings apply to new collaboration conversations on this host.", "随时切换角色编辑；保存后用于当前主机新建的协作对话。")}</Label>
      {restoredDraft && <Label theme={theme}>{ui("Your previous unsaved draft was restored.", "已恢复上次未保存的草稿。")}</Label>}
      {stale && <ErrorText theme={theme} error={ui("The active settings changed. Discard the old draft and reload the settings.", "已生效的设置有更新。请放弃旧草稿并重新读取设置。")} />}
    </View>
    <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 8 }}>
      {steps.map((title, index) => <Pressable key={title} accessibilityRole="tab" accessibilityLabel={title} accessibilityState={{ selected: step === index }} aria-selected={step === index} onPress={() => move(index)} disabled={mutation.isPending} style={{ flex: 1, minWidth: 0, paddingVertical: 11, paddingHorizontal: compact ? 5 : 13, gap: 6, borderRadius: 10, borderWidth: 2, borderColor: step === index ? theme.colors.accent : outline(theme), backgroundColor: step === index ? theme.colors.surface2 : theme.colors.surface1 }}>
        <Text style={{ color: step === index ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>0{index + 1}</Text>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>{title}</Text>
        {!compact && <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{index === 0 ? profileSummary(lead) : index === 1 ? profileSummary(executor) : separateReview ? profileSummary(auditor) : ui("Reuse planning AI", "沿用设计 AI")}</Text>}
      </Pressable>)}
    </View>
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <Label theme={theme} muted>{catalog.isPending ? ui("Loading AIs connected to Paseo…", "正在读取 Paseo 已接入的 AI…") : ui(`${readyCount} AI tools available on this host`, `当前主机有 ${readyCount} 个可用 AI 工具`)}</Label>
        <Button theme={theme} secondary label={catalog.isFetching ? ui("Loading…", "读取中…") : ui("Refresh AI list", "刷新 AI 列表")} disabled={catalog.isFetching} onPress={() => { void catalog.refetch(); }} />
      </View>
      <ErrorText theme={theme} error={catalog.error ? new Error(ui("The AI list could not be loaded. Saved choices are preserved; check the host connection and refresh.", "暂时没能读取 AI 列表。已保存的选择会保留，请检查主机连接后刷新。")) : null} />
      {!catalog.isPending && !catalog.error && !readyCount && <Label theme={theme} muted>{ui("Connect and sign in to an AI tool in Paseo's host settings, then refresh here.", "请先在 Paseo 的主机设置中接入并登录一个 AI 工具，再刷新这里。")}</Label>}
    </View>

    {step === 0 && <Card title={ui("Who creates the plan?", "谁负责设计总纲？")} theme={theme}>
      <Label theme={theme} muted>{ui("The lead agent uses a native conversation to understand requirements, create the plan, and manage subtasks. It requires a model with HTTP MCP tool support. The AI selected in step three performs the review.", "主 Agent 使用原生对话理解需求、制定方案并管理子任务，需要接入支持 HTTP MCP 工具的模型。审核由第三步选择的 AI 负责。")}</Label>
      <ProfileEditor mainChat profile={lead} catalog={catalog.data} theme={theme} onChange={patch => updateRole("director", patch)} />
      {rolePrompt("plan")}
      <SelectionCard theme={theme} title={ui("Let me approve the plan first", "先让我确认设计总纲")} description={approval ? ui("Pause after generating the plan and wait for your approval before writing code.", "总纲生成后暂停，等你确认再开始写代码。") : ui("Automatic mode: hand the plan directly to the implementation AI.", "当前为自动执行：总纲生成后，直接交给执行 AI。")} selected={approval} onPress={() => setApproval(!approval)} />
    </Card>}

    {step === 1 && <>
      <Card title={ui("Who implements the tasks?", "谁负责把任务做出来？")} theme={theme}>
        <Label theme={theme} muted>{ui("The implementation AI completes code and tests from the plan, and handles rework requested during review.", "执行 AI 按总纲完成代码和测试。审核提出修改意见时，也由它继续返工。")}</Label>
        <ProfileEditor profile={executor} catalog={catalog.data} theme={theme} onChange={patch => updateRole("worker", patch)} />
        {rolePrompt("execute")}
      </Card>
      <Card title={ui("Need multiple implementation AIs?", "需要多个执行 AI？")} theme={theme}>
        <Label theme={theme} muted>{ui("One implementation AI is usually enough, but you can assign frontend, backend, and other task types separately.", "通常选一个执行 AI 就够了。你也可以指定前端、后端等任务分别交给谁。")}</Label>
        <Disclosure theme={theme} title={ui("Assign different AIs by task", "按任务分配不同 AI")} summary={assignedCount ? ui(`${assignedCount} assignment rules configured`, `已设置 ${assignedCount} 条指定规则`) : ui("Unassigned tasks go to the default implementation AI", "未指定的任务都交给默认执行 AI")} defaultOpen={!!ruleProfile}>
          <Label theme={theme} muted>{ui("Priority: specific task → category → planning AI selection (when enabled) → default implementer. Choose a configured provider and model here; AI collaboration creates the implementation sessions.", "优先级：具体任务指定 → 类型指定 → 设计 AI 挑选（需开启）→ 默认执行者。这里选择已配置的供应商与模型，执行会话由 AI 协作创建。")}</Label>
          <SelectionCard theme={theme} title={ui("Allow the planning AI to choose implementers", "允许设计 AI 挑选执行者")} description={ui("It can only choose from configured AIs. Your task and category rules still take priority.", "仅从你已配置的 AI 中选择；你指定的任务和类型规则仍然优先。")} selected={allowSelection} onPress={() => setAllowSelection(!allowSelection)} />
          {[...Object.entries(overrides).map(([key, id]) => ({ kind: "category", key, id })), ...Object.entries(taskOverrides).map(([key, id]) => ({ kind: "task", key, id }))].map(rule => <View key={`${rule.kind}-${rule.key}`} style={{ gap: 6 }}>
            <Label theme={theme}>{rule.kind === "category" ? ui("Category", "类型") : ui("Task", "任务")} {rule.key} → {profiles.find(p => p.id === rule.id)?.label ?? rule.id}</Label>
            <Button theme={theme} secondary label={ui(`Remove ${rule.key} rule`, `移除 ${rule.key} 规则`)} onPress={() => (rule.kind === "category" ? setOverrides : setTaskOverrides)(rules => { const next = { ...rules }; delete next[rule.key]; return next; })} />
          </View>)}
          <Choice theme={theme} label={ui("Assignment basis", "按什么分配")} value={ruleKind} options={[{ id: "category", label: ui("Task category (such as frontend or backend)", "任务类型（如前端、后端）") }, { id: "task", label: ui("Task ID from the plan", "总纲中的任务 ID") }]} onChange={kind => { setRuleKind(kind as "category" | "task"); setRuleKey(kind === "category" ? "frontend" : ""); }} />
          {ruleKind === "category" && <View style={{ gap: 6 }}><Label theme={theme} muted>{ui("Select a common category or enter a custom name below.", "点选常用类型，也可以在下方自定义名称。")}</Label><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{taskCategories.map(category => <Button key={category.id} theme={theme} secondary selected={ruleKey === category.id} label={`${category.label} · ${category.id}`} onPress={() => { setRuleKey(category.id); setError(null); }} />)}</View></View>}
          <Field theme={theme} label={ruleKind === "category" ? ui("Task category name", "任务类型名称") : ui("Task ID", "任务 ID")} value={ruleKey} onChange={setRuleKey} placeholder={ruleKind === "category" ? "frontend / backend / tests" : ui("Example: task-1", "例如 task-1")} />
          <Label theme={theme} muted>{ruleKind === "category" ? ui("Enter the exact category name used in the plan.", "填写总纲中使用的类型名称，需要完全一致。") : ui("Only applies to a task whose ID exactly matches the plan.", "只对总纲中 ID 完全相同的任务生效。")}</Label>
          <Choice theme={theme} label={ui("Assign to AI", "交给哪个 AI")} value={ruleProfile} options={choices} onChange={setRuleProfile} />
          <Button theme={theme} secondary label={(ruleKind === "category" ? overrides : taskOverrides)[ruleKey.trim()] ? ui("Update assignment draft", "更新分配草稿") : ui("Add to assignment draft", "添加到分配草稿")} disabled={!ruleKey.trim() || !ruleProfile} onPress={() => {
            try { const rule = makeAssignment(ruleKind, ruleKey, ruleProfile, profiles); (ruleKind === "category" ? setOverrides : setTaskOverrides)(rules => ({ ...rules, [rule.key]: rule.profileId })); setRuleKey(""); setRuleProfile(""); setError(null); }
            catch (error) { setError(error); }
          }} />
          {!!ruleProfile && <Button theme={theme} secondary label={ui("Cancel this rule", "取消这条规则")} onPress={() => { setRuleKey(""); setRuleProfile(""); }} />}
          <Label theme={theme} muted>{ui("After adding it, select “Save settings” below to activate the assignment.", "添加后点击底部“保存设置”，分配才会生效。")}</Label>
        </Disclosure>
        <Disclosure theme={theme} title={ui("Manage other AIs", "管理其他 AI")} summary={ui(`${profiles.length} AIs configured; add more implementers`, `已配置 ${profiles.length} 个 AI，可添加更多执行者`)} defaultOpen={!!extraProfile}>
          {profiles.map(profile => {
            const inUse = [director, worker, ...(separateReview ? [reviewer] : []), ...Object.values(overrides), ...Object.values(taskOverrides)].includes(profile.id);
            return <View key={profile.id} style={{ gap: 6, borderBottomWidth: 1, paddingBottom: 12, borderColor: outline(theme, "panel") }}>
              <Label theme={theme}>{profile.label} · {profile.provider}</Label>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <Button theme={theme} secondary label={ui(`Edit ${profile.label}`, `编辑 ${profile.label}`)} disabled={!!extraProfile} onPress={() => setExtraProfile({ ...profile })} />
                <Button theme={theme} secondary label={ui(`Delete ${profile.label}`, `删除 ${profile.label}`)} disabled={inUse || !!extraProfile} onPress={() => setProfiles(ps => ps.filter(p => p.id !== profile.id))} />
              </View>
              {inUse && <Label theme={theme} muted>{ui("This AI is used by a role or assignment rule. Change those assignments before deleting it.", "正在用于角色或分配规则，调整分配后可删除。")}</Label>}
            </View>;
          })}
          {!extraProfile ? <Button theme={theme} secondary label={ui("Add another AI", "添加其他 AI")} onPress={() => setExtraProfile({ id: newId(), label: ui("Additional implementation AI", "其他执行 AI"), provider: "", transport: "structured" })} /> : <View style={{ gap: 12 }}>
            <ProfileEditor profile={extraProfile} catalog={catalog.data} theme={theme} onChange={patch => setExtraProfile(p => p ? { ...p, ...patch } : p)} />
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              <Button theme={theme} label={ui("Apply to AI draft", "应用到 AI 草稿")} onPress={() => {
                const message = roleError(extraProfile, ui("this AI", "这个 AI"));
                if (message) { setError(new Error(message)); return; }
                setProfiles(ps => [...ps.filter(p => p.id !== extraProfile.id), extraProfile]); setExtraProfile(null); setError(null);
              }} />
              <Button theme={theme} secondary label={ui("Cancel AI editing", "取消编辑 AI")} onPress={() => { setExtraProfile(null); setError(null); }} />
            </View>
          </View>}
        </Disclosure>
      </Card>
    </>}

    {step === 2 && <>
      <Card title={ui("Who reviews the final result?", "谁负责检查最终成果？")} theme={theme}>
        <Label theme={theme} muted>{ui("After all tasks finish serially, the review AI checks the combined result and integration, then returns issues to the implementation AI for rework. It reviews code but does not edit it directly.", "全部任务串行完成后，审核 AI 统一检查各项成果和集成效果，提出问题后交给执行 AI 返工。它负责审核，不直接修改代码。")}</Label>
        <View accessibilityRole="radiogroup" accessibilityLabel={ui("Review method", "审核方式")} style={{ gap: 8 }}>
          <SelectionCard role="radio" theme={theme} title={ui("Reuse the planning AI for review", "沿用设计 AI 审核")} description={ui("Complete the review in the planning AI's existing conversation.", "使用设计 AI 的原会话完成审核，保持现有协作方式。")} selected={!separateReview} onPress={() => { setSeparateReview(false); setError(null); }} />
          <SelectionCard role="radio" theme={theme} title={ui("Choose a separate review AI", "单独选择审核 AI")} description={ui("Create a separate review conversation with its own provider, model, permissions, and reasoning effort.", "新建独立审核会话，可以选择不同的供应商、模型、权限和推理强度。")} selected={separateReview} onPress={() => { setSeparateReview(true); setError(null); }} />
        </View>
        {separateReview ? <>
          <ProfileEditor profile={auditor} catalog={catalog.data} theme={theme} onChange={patch => updateRole("reviewer", patch)} />
          <Label theme={theme} muted>{ui("Review uses a separate conversation. The plan, code diff, and implementation reports are sent to it automatically.", "审核使用独立会话。设计总纲、代码差异和执行报告会自动传给它。")}</Label>
        </> : <><Label theme={theme}>{ui(`Review model: ${profileSummary(lead)}`, `审核模型：${profileSummary(lead)}`)}</Label><Label theme={theme} muted>{ui("Review reuses the planning AI's conversation and permissions. Choose a separate review AI if different permissions are needed.", "审核沿用设计 AI 的会话和执行权限；需要不同权限时请选择独立审核 AI。")}</Label></>}
        {rolePrompt("review")}
      </Card>
      <Card title={ui("Review and final acceptance", "审核与最终验收")} theme={theme}>
        <Label theme={theme}>{ui("After all tasks finish, the review AI checks the combined result and runs tests as needed, deciding whether to approve or request rework. Once approved, you accept the result or request changes. You do not need to enter test commands.", "全部任务执行完成后，审核 AI 统一检查并按需运行测试，决定通过或返工。最终审核通过后，由你验收或提出修改意见。你无需填写测试命令。")}</Label>
        <Disclosure theme={theme} title={ui("Specify additional check commands (optional)", "指定额外检查命令（可选）")} summary={checks.length ? ui(`${checks.length} configured; run before AI review`, `已配置 ${checks.length} 项，将在 AI 审核前执行`) : ui("The review AI chooses verification by default", "默认由审核 AI 决定验证方式")} defaultOpen={showCommand}>
        <Label theme={theme} muted>{ui("Only configure this when specific tests or builds must always run. Each command runs once before every final review; a failure prevents approval.", "只有你想固定执行某些测试或构建时才需要设置。指定后，每轮统一审核前运行一次；失败时不能批准成果。")}</Label>
        {checks.length > 0 && <Button theme={theme} secondary label={ui("Remove all additional checks", "移除全部额外检查")} disabled={showCommand} onPress={() => { setChecks([]); setError(null); }} />}
        <Text style={{ color: theme.colors.foreground, fontWeight: "600", marginTop: 4 }}>{ui("Common checks", "点选常用检查")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          {checkPresets.map(preset => {
            const selected = checks.some(c => sameCommand(c, preset.command));
            return <View key={preset.id} style={{ flexBasis: compact ? "100%" : "48%", flexGrow: 1, minWidth: 0 }}><SelectionCard theme={theme} title={preset.title} description={preset.description} detail={commandLine(preset.command)} selected={selected} disabled={editingCheck !== null} onPress={() => {
              if (!selected && checks.length >= 12) { setError(new Error(ui("You can add up to 12 checks.", "最多添加 12 项检查。"))); return; }
              setChecks(cs => selected ? cs.filter(c => !sameCommand(c, preset.command)) : [...cs, { ...preset.command, args: [...preset.command.args] }]); setError(null);
            }} /></View>;
          })}
        </View>
        <View style={{ borderTopWidth: 1, borderColor: outline(theme, "panel"), paddingTop: 14, gap: 12 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{ui(`Selected checks · ${checks.length}`, `已选检查 · ${checks.length} 项`)}</Text>
          {!checks.length && <Label theme={theme} muted>{ui("No additional checks specified. The review AI decides how to verify the result.", "未指定额外检查，审核 AI 会自行决定如何验证。")}</Label>}
          {checks.map((check, index) => <View key={index} style={{ gap: 6, padding: 12, backgroundColor: theme.colors.surface0, borderRadius: 8 }}>
            <Label theme={theme}>{check.label}</Label><Label theme={theme}>{commandLine(check)}</Label>
            <Label theme={theme} muted>{ui(`Maximum runtime: ${Number((check.timeoutMs / 60000).toFixed(2))} minutes`, `最多运行 ${Number((check.timeoutMs / 60000).toFixed(2))} 分钟`)}</Label>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button theme={theme} secondary label={ui(`Edit check ${index + 1}`, `编辑检查 ${index + 1}`)} disabled={showCommand} onPress={() => { setEditingCheck(index); setCheckLabel(check.label); setCheckLine(commandLine(check)); setCheckMinutes(String(check.timeoutMs / 60000)); setShowCommand(true); setError(null); }} />
              <Button theme={theme} secondary label={ui(`Remove check ${index + 1}`, `移除检查 ${index + 1}`)} disabled={editingCheck !== null} onPress={() => setChecks(cs => cs.filter((_, i) => i !== index))} />
            </View>
          </View>)}
        </View>
        {!showCommand ? <Button theme={theme} secondary label={ui("Enter another command", "填写其他命令")} disabled={checks.length >= 12} onPress={() => setShowCommand(true)} /> : <View style={{ padding: 14, gap: 12, borderWidth: 1, borderColor: outline(theme, "panel"), borderRadius: 10 }}>
          <Field theme={theme} label={ui("Full check command", "完整检查命令")} value={checkLine} onChange={setCheckLine} placeholder={ui("Example: pnpm run typecheck", "例如 pnpm run typecheck")} />
          <Label theme={theme} muted>{ui("Enter one command as you would in a terminal. Add multiple checks separately and quote paths containing spaces.", "像在终端里一样填写一条命令。多条检查请分别添加；带空格的路径用引号包住。")}</Label>
          <Disclosure theme={theme} title={ui("Check name and timeout", "检查名称与时限")} summary={ui(`${checkLabel || "Command used as name"} · up to ${checkMinutes} minutes`, `${checkLabel || "名称默认使用命令"} · 最多 ${checkMinutes} 分钟`)}>
            <Field theme={theme} label={ui("Check name (optional)", "检查名称（可选）")} value={checkLabel} onChange={setCheckLabel} placeholder={ui("Example: Type check", "例如：类型检查")} />
            <Field theme={theme} label={ui("Maximum runtime in minutes", "这项检查最多运行几分钟")} value={checkMinutes} onChange={setCheckMinutes} />
          </Disclosure>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button theme={theme} label={editingCheck === null ? ui("Add this check", "添加这项检查") : ui("Update check", "更新检查")} onPress={addCheck} />
            <Button theme={theme} secondary label={ui("Cancel check editing", "取消编辑检查")} onPress={resetCommand} />
          </View>
        </View>}
        </Disclosure>
      </Card>
      <Card title={ui("Confirm your setup", "确认你的安排")} theme={theme}>
        <Label theme={theme}>{ui(`Planning AI: ${profileSummary(lead)}\nImplementation AI: ${profileSummary(executor)}\nReview AI: ${profileSummary(separateReview ? auditor : lead)}${separateReview ? " (separate conversation)" : " (reuse planning conversation)"}`, `设计 AI：${profileSummary(lead)}\n执行 AI：${profileSummary(executor)}\n审核 AI：${profileSummary(separateReview ? auditor : lead)}${separateReview ? "（独立会话）" : "（沿用设计会话）"}`)}</Label>
        <Label theme={theme} muted>{ui(`${approval ? "Wait for your approval after planning" : "Start implementation automatically after planning"} · you accept after AI review${checks.length ? ` · ${checks.length} additional checks` : ""}${assignedCount ? ` · ${assignedCount} implementation assignment rules` : ""}`, `${approval ? "设计完成后等你确认" : "设计完成后自动开始执行"} · AI 审核后由你验收${checks.length ? ` · ${checks.length} 项额外检查` : ""}${assignedCount ? ` · ${assignedCount} 条执行分配规则` : ""}`)}</Label>
        <Label theme={theme} muted>{ui(`${Object.values(rolePrompts).filter(value => value?.trim()).length} role instruction sets and ${profiles.filter(profile => profile.instructions?.trim()).length} AI-specific instruction sets entered. Each step sends the applicable instructions based on its role and assignment. Saving only affects new tasks.`, `已填写 ${Object.values(rolePrompts).filter(value => value?.trim()).length} 份角色前置提示词、${profiles.filter(profile => profile.instructions?.trim()).length} 份 AI 补充提示词。每轮会按实际角色与分配结果发送，保存后仅影响新任务。`)}</Label>
        <Disclosure theme={theme} title={ui("Advanced run settings", "运行高级设置")} summary={ui(`Up to ${maxReworks} reworks per task · ${turnMinutes} minutes per AI call`, `每项最多返工 ${maxReworks} 次 · 单次 AI 最多 ${turnMinutes} 分钟`)}>
          <Label theme={theme} muted>{ui("Automatic progress pauses when a limit is reached. The defaults are suitable for an initial run.", "达到上限后暂停自动推进，等你处理。默认值适合先跑通一个任务。")}</Label>
          <Field theme={theme} label={ui("Maximum reworks per task", "每项任务最多返工几次")} value={maxReworks} onChange={setMaxReworks} />
          <Field theme={theme} label={ui("Maximum minutes per AI call", "单次 AI 最多运行几分钟")} value={turnMinutes} onChange={setTurnMinutes} />
          <Label theme={theme} muted>{ui("Submitting changes during final acceptance starts a new budget. Waiting for your acceptance does not time out.", "最终验收时主动提交修改意见，会开启新一轮预算；等待你验收不会超时。")}</Label>
          <Field theme={theme} label={ui("Maximum AI calls per run", "每轮任务最多调用 AI 几次")} value={maxAttempts} onChange={setMaxAttempts} />
          <Field theme={theme} label={ui("Maximum hours per run", "每轮任务最多运行几小时")} value={runHours} onChange={setRunHours} />
        </Disclosure>
      </Card>
    </>}
    </View>
    </ScrollView>
    <View style={{ borderTopWidth: 1, borderColor: outline(theme, "panel"), backgroundColor: theme.colors.surface1 }}>
    <View style={{ padding: compact ? 12 : 16, gap: 8, maxWidth: 1100, width: "100%", alignSelf: "center" }}>
      <ErrorText theme={theme} error={error ?? mutation.error ?? writer.error} />
      <Label theme={theme} muted>{writer.error ? ui("The draft has not synced. Retry or keep this panel open.", "草稿尚未同步，请重试或先保留此面板。") : writer.busy ? ui("Saving draft…", "正在保留草稿…") : dirty ? ui("Unapplied changes · draft saved on this host", "有未生效的修改 · 草稿已保留在当前主机") : base ? ui("Settings match the saved version", "设置与已保存内容一致") : ui("Choose planning and implementation AIs, then save the team settings", "先选择设计与执行 AI，再保存团队设置")}</Label>
      {confirmReset ? <>
        <Label theme={theme}>{ui("Discard the unsaved draft and load the active settings?", "放弃未保存的草稿并读取已生效的设置？")}</Label>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button theme={theme} secondary label={ui("Keep draft", "保留草稿")} disabled={locked} onPress={() => setConfirmReset(false)} />
          <Button theme={theme} label={ui("Discard and reload", "放弃并重新读取")} disabled={locked} onPress={() => { void discard(); }} />
        </View>
      </> : <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button theme={theme} label={mutation.isPending ? ui("Saving…", "保存中…") : ui("Save settings", "保存设置")} disabled={locked || stale} onPress={saveAll} />
        {step < 2 && <Button theme={theme} secondary label={ui("Next", "下一步")} disabled={locked} onPress={next} />}
        {step > 0 && <Button theme={theme} secondary label={ui("Previous", "上一步")} disabled={locked} onPress={() => move(step - 1)} />}
        {(dirty || restoredDraft) && <Button theme={theme} secondary label={ui("Discard draft", "放弃草稿")} disabled={locked} onPress={() => setConfirmReset(true)} />}
        {!!writer.error && <Button theme={theme} secondary label={ui("Retry saving draft", "重试保留草稿")} disabled={locked} onPress={() => { void writer.flush().catch(() => {}); }} />}
        {(writer.error || mutation.error) && <Button theme={theme} secondary label={ui("Discard page changes and load the latest draft", "放弃本页修改，读取最新草稿")} disabled={locked} onPress={() => { setResetting(true); void onReload().finally(() => setResetting(false)); }} />}
      </View>}
    </View>
    </View>
  </View>;
}
