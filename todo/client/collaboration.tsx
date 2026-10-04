import { useState } from 'react';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  COLLABORATION_ROLE_LABELS,
  collaborationDraftIssue,
  collaborationModeLabel,
  collaborationStatus,
  collaborationWarning,
  promptExamples,
  type CollaborationCatalog,
  type CollaborationDefaultStore,
  type CollaborationDraft,
  type CollaborationDraftIssue,
  type CollaborationMode,
  type RoleSelection,
  type TaskCollaboration,
} from '../shared/collaboration';
import type { Catalog } from '../shared/schema';
import { explain, ui } from './i18n';
import { Button, outline, SectionTitle, tint, type Colors } from './kit';
import { Select, type SelectOption } from './select';

type RoleName = 'director' | 'worker' | 'reviewer';

const RUN_TIMEOUTS = [1, 2, 4, 8, 12, 24].map(hours => hours * 3_600_000);
const TURN_TIMEOUTS = [5, 10, 15, 30, 60, 120].map(minutes => minutes * 60_000);

export function browserCollaborationStore(): CollaborationDefaultStore | null {
  try {
    const storage = (globalThis as { localStorage?: CollaborationDefaultStore }).localStorage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return null;
    return storage;
  } catch {
    return null;
  }
}

export function collaborationIssueText(issue: CollaborationDraftIssue): string {
  switch (issue.code) {
    case 'loading':
      return ui('Reading this host\'s collaboration support…', '正在读取这台主机的协作能力…');
    case 'unavailable':
      return issue.detail || explain('collaboration-unavailable');
    case 'inline-models':
      return explain('collaboration-unavailable', issue.detail || ui('This host will not apply per-task collaboration settings.', '主机不会按任务使用协作设置。'));
    case 'execute-review':
      return explain('collaboration-unavailable', issue.detail || ui('This host does not support execute + review.', '主机不支持执行＋审核。'));
    case 'foreign-provider':
      return ui(`This host has no provider ${issue.detail ?? ''}. Pick a model on this host.`, `这台主机没有供应商 ${issue.detail ?? ''}。请改选这台主机上的模型。`);
    case 'director-required':
      return ui('Choose a lead agent.', '请选择主 Agent。');
    case 'worker-required':
      return ui('Choose a worker.', '请选择执行 Agent。');
    case 'reviewer-required':
      return ui('Execute + review needs its own reviewer.', '执行＋审核模式需要独立审核 Agent，请先在协作设置中指定审核 Agent。');
    case 'reviewer-incomplete':
      return ui('Choose the reviewer\'s provider and model.', '请选择审核 Agent 的供应商和模型。');
    case 'prompt-too-long':
      return ui('A role prompt is longer than 8000 characters.', '有一条角色提示词超过 8000 字。');
    case 'role-prompts':
      return explain('collaboration-prompts-unavailable');
    case 'command-incomplete':
      return ui('Finish or remove the incomplete verification command.', '请补全或删除未写完的验证命令。');
    case 'invalid':
      return issue.detail || explain('collaboration-invalid');
  }
}

function modelValue(selection: RoleSelection | null): string {
  return selection ? `${selection.provider}/${selection.model}` : '';
}

function modelOptions(catalog: Catalog | null, selection: RoleSelection | null): SelectOption[] {
  const options = catalog?.providers.flatMap(entry => entry.models.map(model => ({
    value: `${entry.provider}/${model.id}`,
    label: model.label,
    group: entry.label,
  }))) ?? [];
  if (selection && !options.some(option => option.value === modelValue(selection))) {
    options.unshift({ value: modelValue(selection), label: selection.modelLabel, group: selection.providerLabel });
  }
  return options;
}

function modeOptions(catalog: Catalog | null, selection: RoleSelection | null): SelectOption[] {
  const provider = selection ? catalog?.providers.find(entry => entry.provider === selection.provider) : undefined;
  const options = (provider?.modes ?? []).map(mode => ({ value: mode.id, label: mode.label }));
  if (selection?.modeId && !options.some(option => option.value === selection.modeId)) {
    options.unshift({ value: selection.modeId, label: selection.modeId });
  }
  return [{ value: '', label: ui('Default permission', '默认权限') }, ...options];
}

function withChoice(current: number, choices: readonly number[]): number[] {
  return choices.includes(current) ? [...choices] : [...choices, current].sort((left, right) => left - right);
}

function durationLabel(ms: number, unit: 'h' | 'm'): string {
  const count = unit === 'h' ? Math.round(ms / 3_600_000) : Math.round(ms / 60_000);
  return unit === 'h' ? ui(`${count} h`, `${count} 小时`) : ui(`${count} min`, `${count} 分钟`);
}

export function CollaborationSummary(props: {
  collaboration: TaskCollaboration | null;
  phase?: string | null;
  control?: string | null;
  acceptance?: 'pending' | 'accepted' | null;
  catalog: Catalog | null;
  colors: Colors;
}) {
  const { colors } = props;
  const collaboration = props.collaboration;
  const status = collaborationStatus({
    collaboration,
    collaborationPhase: props.phase ?? null,
    collaborationControl: props.control ?? null,
    collaborationAcceptance: props.acceptance ?? null,
  });
  if (!collaboration) {
    return <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('Collaboration is off. One agent runs this task.', '协作关闭。这个任务由单个 Agent 执行。')}</Text>;
  }
  const settings = collaboration.settings;
  const roles = [
    ['director', settings.directorProfileId],
    ['worker', settings.workerProfileId],
    ...(settings.reviewerProfileId ? [['reviewer', settings.reviewerProfileId] as const] : []),
  ] as const;
  return <View style={{ gap: 8 }}>
    <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{ui(...collaborationModeLabel(collaboration.mode))}</Text>
    {roles.map(([role, id]) => {
      const profile = settings.profiles.find(item => item.id === id);
      if (!profile || (role === 'director' && id === settings.workerProfileId)) return null;
      const slash = profile.provider.indexOf('/');
      const providerId = profile.provider.slice(0, slash);
      const modelId = profile.provider.slice(slash + 1);
      const entry = props.catalog?.providers.find(item => item.provider === providerId);
      const providerLabel = entry?.label ?? providerId;
      const modelLabel = entry?.models.find(item => item.id === modelId)?.label ?? profile.label;
      const permission = entry?.modes.find(item => item.id === profile.modeId)?.label ?? profile.modeId;
      return <Text key={role} style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
        {ui(...COLLABORATION_ROLE_LABELS[role])} · {providerLabel} · {modelLabel}{permission ? ` · ${permission}` : ''}
      </Text>;
    })}
    <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
      {ui('Reworks', '返工')} {settings.maxReworks} · {ui('Time budget', '时间预算')} {durationLabel(settings.runTimeoutMs, 'h')}
      {collaboration.mode === 'full' && settings.requirePlanApproval ? ` · ${ui('Plan approval required', '需要批准方案')}` : ''}
    </Text>
    {status ? <View style={{ gap: 4, padding: 10, borderRadius: 10, backgroundColor: tint(colors.statusWarning, 0.08) }}>
      <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600' }}>{ui(...status.title)}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{ui(...status.detail)}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
        {ui('Host phase', '协作阶段')} {props.phase ?? '—'} · {ui('Host control', '协作控制')} {props.control ?? '—'}
      </Text>
    </View> : null}
  </View>;
}

export function CollaborationForm(props: {
  draft: CollaborationDraft;
  catalog: Catalog | null;
  collaboration: CollaborationCatalog | null;
  colors: Colors;
  disabled?: boolean;
  onChange(draft: CollaborationDraft): void;
}) {
  const { colors, draft } = props;
  const [picker, setPicker] = useState<string | null>(null);
  const disabled = props.disabled;
  const warning = collaborationWarning(props.collaboration);
  const modes: Array<'off' | CollaborationMode> = ['off', 'full', 'execute_review'];
  const selectedMode = draft.enabled ? draft.mode : 'off';
  const setMode = (mode: 'off' | CollaborationMode) => {
    if (disabled) return;
    if (mode === 'off') props.onChange({ ...draft, enabled: false });
    else props.onChange({ ...draft, enabled: true, mode });
  };
  const setRole = (role: RoleName, value: string) => {
    if (!value) {
      props.onChange({ ...draft, [role]: null });
      return;
    }
    const slash = value.indexOf('/');
    const provider = value.slice(0, slash);
    const model = value.slice(slash + 1);
    const entry = props.catalog?.providers.find(item => item.provider === provider);
    const previous = draft[role];
    const same = previous?.provider === provider && previous.model === model;
    props.onChange({
      ...draft,
      [role]: {
        provider,
        model,
        modeId: same ? previous.modeId : null,
        providerLabel: entry?.label ?? provider,
        modelLabel: entry?.models.find(item => item.id === model)?.label ?? previous?.modelLabel ?? model,
      },
    });
  };
  const setPermission = (role: RoleName, modeId: string) => {
    const selection = draft[role];
    if (!selection) return;
    props.onChange({ ...draft, [role]: { ...selection, modeId: modeId || null } });
  };
  const patchPreserved = (patch: Partial<CollaborationDraft['preserved']>) => {
    props.onChange({ ...draft, preserved: { ...draft.preserved, ...patch } });
  };
  const roleRow = (role: RoleName, optional: boolean) => {
    const selection = draft[role];
    const options = modelOptions(props.catalog, selection);
    const fallback = role === 'director' ? ui('Use worker for the conversation', '会话使用执行配置') : ui('Reviewed by the lead agent', '由主 Agent 审核');
    if (optional) options.unshift({ value: '', label: fallback });
    return <View key={role} style={{ gap: 6 }}>
      <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600' }}>{ui(...COLLABORATION_ROLE_LABELS[role])}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, zIndex: picker?.startsWith(role) ? 20 : 1 }}>
        <Select
          label={ui(...COLLABORATION_ROLE_LABELS[role])} icon="Bot" colors={colors}
          value={modelValue(selection)} options={options}
          placeholder={optional ? fallback : ui('Choose a model', '选择模型')}
          disabled={disabled || options.length === (optional ? 1 : 0)}
          open={picker === role} onOpenChange={open => setPicker(open ? role : null)}
          onChange={value => setRole(role, value)}
        />
        {selection ? <Select
          label={ui('Permission', '权限')} icon="Shield" colors={colors}
          value={selection.modeId ?? ''} options={modeOptions(props.catalog, selection)}
          placeholder={ui('Default permission', '默认权限')}
          disabled={disabled}
          open={picker === `${role}-mode`} onOpenChange={open => setPicker(open ? `${role}-mode` : null)}
          onChange={value => setPermission(role, value)}
        /> : null}
      </View>
    </View>;
  };
  return <View style={{ gap: 14 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {modes.map(mode => {
        const active = selectedMode === mode;
        const label = ui(...collaborationModeLabel(mode));
        return <Pressable key={mode} accessibilityRole="button" accessibilityState={{ selected: active }} disabled={disabled} onPress={() => setMode(mode)} style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: active ? colors.foreground : outline(colors), backgroundColor: active ? tint(colors.foreground, 0.12) : 'transparent', opacity: disabled ? 0.5 : 1 }}>
          <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600' }}>{label}</Text>
        </Pressable>;
      })}
    </View>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
      {selectedMode === 'off'
        ? ui('One agent runs the task. Nothing merges until you accept it.', '单个 Agent 执行。你验收之前不会合并。')
        : selectedMode === 'full'
          ? ui('Design, then execute, then review. You accept the result.', '设计 → 执行 → 审核 → 你验收。')
          : ui('One worker, then a separate reviewer. You accept the result.', '一个执行 Agent，独立审核后交你验收。')}
    </Text>
    {draft.enabled ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
      {ui('The task already has its own worktree, so collaboration stays in that directory and does not open a second one.', '任务已经有独立工作树，协作就在这个目录里运行，不会再开一个工作树。')}
    </Text> : null}
    {warning ? <Text style={{ color: colors.statusWarning, fontSize: 12, lineHeight: 18 }}>{warning}</Text> : null}
    {draft.enabled ? <>
      <View style={{ gap: 10 }}>
        <SectionTitle colors={colors}>{ui('Agents', '协作 Agent')}</SectionTitle>
        {roleRow('director', draft.mode === 'execute_review')}
        {roleRow('worker', false)}
        {roleRow('reviewer', draft.mode === 'full')}
        {draft.mode === 'execute_review' ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('The reviewer can use the same model as the worker, but it is a separate agent.', '审核可以和执行用同一个模型，但必须是独立的 Agent。')}</Text> : null}
      </View>
      <View style={{ gap: 8 }}>
        <SectionTitle colors={colors}>{ui('Prompts', '提示词')}</SectionTitle>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{ui('This host uses its global role prompts. Explicit task prompts must match them; blank fields use the host defaults.', '这台主机使用统一角色提示词。填写的任务提示词必须与主机一致；留空使用主机默认设置。')}</Text>
        {(['plan', 'execute', 'review'] as const).map(role => <View key={role} style={{ gap: 4 }}>
            <Text style={{ color: colors.foreground, fontSize: 12 }}>{role === 'plan' ? ui('Design prompt', '设计提示词') : role === 'execute' ? ui('Execute prompt', '执行提示词') : ui('Review prompt', '审核提示词')}</Text>
          <TextInput
            value={draft.prompts[role]}
            editable={!disabled}
            onChangeText={value => props.onChange({ ...draft, prompts: { ...draft.prompts, [role]: value } })}
            multiline
            placeholder={promptExamples[role]}
            placeholderTextColor={tint(colors.foregroundMuted, 0.55)}
            style={{ minHeight: 72, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: outline(colors), backgroundColor: colors.surface1, color: colors.foreground, fontSize: 12, lineHeight: 18, textAlignVertical: 'top', outlineStyle: 'solid', outlineWidth: 0 }}
          />
        </View>)}
      </View>
      <View style={{ gap: 8 }}>
        <SectionTitle colors={colors}>{ui('Limits', '限制')}</SectionTitle>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, zIndex: picker === 'rework' || picker === 'run' || picker === 'turn' ? 20 : 1 }}>
          <Select label={ui('Reworks', '返工')} icon="RotateCcw" colors={colors} value={String(draft.maxReworks)} options={Array.from({ length: 11 }, (_, count) => ({ value: String(count), label: String(count) }))} placeholder="2" disabled={disabled} open={picker === 'rework'} onOpenChange={open => setPicker(open ? 'rework' : null)} onChange={value => props.onChange({ ...draft, maxReworks: Number(value) })} />
          <Select label={ui('Time budget', '时间预算')} icon="Timer" colors={colors} value={String(draft.runTimeoutMs)} options={withChoice(draft.runTimeoutMs, RUN_TIMEOUTS).map(ms => ({ value: String(ms), label: durationLabel(ms, 'h') }))} placeholder={durationLabel(draft.runTimeoutMs, 'h')} disabled={disabled} open={picker === 'run'} onOpenChange={open => setPicker(open ? 'run' : null)} onChange={value => props.onChange({ ...draft, runTimeoutMs: Number(value) })} />
          <Select label={ui('Step limit', '单步时限')} icon="Timer" colors={colors} value={String(draft.turnTimeoutMs)} options={withChoice(draft.turnTimeoutMs, TURN_TIMEOUTS).map(ms => ({ value: String(ms), label: durationLabel(ms, 'm') }))} placeholder={durationLabel(draft.turnTimeoutMs, 'm')} disabled={disabled} open={picker === 'turn'} onOpenChange={open => setPicker(open ? 'turn' : null)} onChange={value => props.onChange({ ...draft, turnTimeoutMs: Number(value) })} />
        </View>
        <TextInput
          value={String(draft.maxAttempts)}
          editable={!disabled}
          onChangeText={value => {
            const digits = value.replace(/\D/g, '');
            if (!digits) return;
            props.onChange({ ...draft, maxAttempts: Math.min(200, Math.max(3, Number(digits))) });
          }}
          keyboardType="number-pad"
          accessibilityLabel={ui('Attempts per round', '每轮最多操作次数')}
          style={{ height: 34, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: outline(colors), color: colors.foreground, fontSize: 12, outlineStyle: 'solid', outlineWidth: 0 }}
        />
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Attempts per round', '每轮最多操作次数')}</Text>
        {draft.mode === 'full' ? <CheckRow colors={colors} checked={draft.requirePlanApproval} disabled={disabled} label={ui('Require plan approval', '要求批准方案')} onPress={() => props.onChange({ ...draft, requirePlanApproval: !draft.requirePlanApproval })} /> : null}
        <CheckRow colors={colors} checked={draft.preserved.allowDirectorSelection} disabled={disabled} label={ui('Let the lead agent choose the worker profile', '允许主 Agent 选择执行配置')} onPress={() => patchPreserved({ allowDirectorSelection: !draft.preserved.allowDirectorSelection })} />
      </View>
      <View style={{ gap: 8 }}>
        <SectionTitle colors={colors}>{ui('Verification commands', '验证命令')}</SectionTitle>
        {draft.preserved.verificationCommands.map((command, index) => <View key={index} style={{ gap: 6 }}>
          <TextInput value={command.label} editable={!disabled} onChangeText={label => patchPreserved({ verificationCommands: draft.preserved.verificationCommands.map((item, itemIndex) => itemIndex === index ? { ...item, label } : item) })} placeholder={ui('Label', '名称')} placeholderTextColor={tint(colors.foregroundMuted, 0.55)} style={fieldStyle(colors)} />
          <TextInput value={command.command} editable={!disabled} onChangeText={executable => patchPreserved({ verificationCommands: draft.preserved.verificationCommands.map((item, itemIndex) => itemIndex === index ? { ...item, command: executable } : item) })} placeholder={ui('Command', '命令')} placeholderTextColor={tint(colors.foregroundMuted, 0.55)} autoCapitalize="none" autoCorrect={false} style={fieldStyle(colors)} />
          {command.args.map((argument, argumentIndex) => <View key={argumentIndex} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <TextInput value={argument} editable={!disabled} onChangeText={value => patchPreserved({ verificationCommands: draft.preserved.verificationCommands.map((item, itemIndex) => itemIndex === index ? { ...item, args: item.args.map((arg, argIndex) => argIndex === argumentIndex ? value : arg) } : item) })} placeholder={ui('Argument', '参数')} placeholderTextColor={tint(colors.foregroundMuted, 0.55)} autoCapitalize="none" autoCorrect={false} style={{ ...fieldStyle(colors), flex: 1 }} />
            {!disabled ? <Button label={ui('Remove argument', '删除参数')} icon="X" colors={colors} variant="ghost" size="xs" onPress={() => patchPreserved({ verificationCommands: draft.preserved.verificationCommands.map((item, itemIndex) => itemIndex === index ? { ...item, args: item.args.filter((_, argIndex) => argIndex !== argumentIndex) } : item) })} /> : null}
          </View>)}
          {!disabled ? <Button label={ui('Add argument', '添加参数')} icon="Plus" colors={colors} variant="outline" size="xs" disabled={command.args.length >= 80} onPress={() => patchPreserved({ verificationCommands: draft.preserved.verificationCommands.map((item, itemIndex) => itemIndex === index ? { ...item, args: [...item.args, ''] } : item) })} /> : null}
          {!disabled ? <Button label={ui('Remove command', '删除命令')} icon="X" colors={colors} variant="ghost" size="xs" onPress={() => patchPreserved({ verificationCommands: draft.preserved.verificationCommands.filter((_, itemIndex) => itemIndex !== index) })} /> : null}
        </View>)}
        {!disabled ? <Button label={ui('Add command', '添加命令')} icon="Plus" colors={colors} variant="outline" size="xs" onPress={() => patchPreserved({ verificationCommands: [...draft.preserved.verificationCommands, { label: '', command: '', args: [], timeoutMs: 120_000 }] })} /> : null}
      </View>
      {Object.keys(draft.preserved.categoryOverrides).length || Object.keys(draft.preserved.taskOverrides).length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
        {ui('Category and task assignments from the saved settings are kept.', '已保存设置里的类别和任务分配会保留。')}
      </Text> : null}
    </> : null}
    {picker ? <Pressable accessibilityLabel={ui('Close list', '关闭列表')} onPress={() => setPicker(null)} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 4 }} /> : null}
  </View>;
}

function fieldStyle(colors: Colors) {
  return { height: 34, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: outline(colors), color: colors.foreground, fontSize: 12, outlineStyle: 'solid' as const, outlineWidth: 0 };
}

function CheckRow(props: { colors: Colors; checked: boolean; disabled?: boolean; label: string; onPress(): void }) {
  const { colors } = props;
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: props.checked, disabled: props.disabled }} disabled={props.disabled} onPress={props.onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, opacity: props.disabled ? 0.5 : 1 }}>
    <View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: outline(colors), alignItems: 'center', justifyContent: 'center', backgroundColor: props.checked ? colors.foreground : 'transparent' }}>
      {props.checked ? <Icon name="Check" size={12} color={colors.surface0} /> : null}
    </View>
    <Text style={{ flex: 1, color: colors.foreground, fontSize: 12 }}>{props.label}</Text>
  </Pressable>;
}

export function CollaborationEditorModal(props: {
  title: string;
  hint: string;
  draft: CollaborationDraft;
  catalog: Catalog | null;
  collaboration: CollaborationCatalog | null;
  colors: Colors;
  width: number;
  busy?: boolean;
  error: string | null;
  saveLabel: string;
  hosts?: readonly { id: string; label: string }[];
  hostId?: string;
  onHostChange?(hostId: string): void;
  onChange(draft: CollaborationDraft): void;
  onSave(): void;
  onCancel(): void;
}) {
  const { colors } = props;
  const providerIds = props.catalog?.providers.map(provider => provider.provider) ?? null;
  const issue = collaborationDraftIssue(props.draft, props.collaboration, props.catalog ? providerIds : null);
  const [hostOpen, setHostOpen] = useState(false);
  const cancel = () => { if (!props.busy) props.onCancel(); };
  return <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 40, alignItems: 'center', justifyContent: 'center' }}>
    <Pressable accessibilityLabel={ui('Cancel', '取消')} onPress={cancel} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.5)' }} />
    <View style={{ width: Math.min(640, Math.max(280, props.width - 24)), maxHeight: '90%', borderRadius: 16, borderWidth: 1, borderColor: outline(colors), backgroundColor: colors.surface0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8 }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 16, fontWeight: '700' }}>{props.title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={ui('Close', '关闭')} onPress={cancel} style={{ padding: 4 }}>
          <Icon name="X" size={16} color={colors.foregroundMuted} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16, gap: 12 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{props.hint}</Text>
        {props.hosts && props.hosts.length > 1 && props.hostId && props.onHostChange ? <Select
          label={ui('Machine', '机器')} icon="Server" colors={colors}
          value={props.hostId}
          options={props.hosts.map(host => ({ value: host.id, label: host.label }))}
          placeholder={ui('Choose a machine', '选择机器')}
          open={hostOpen} onOpenChange={setHostOpen} onChange={props.onHostChange}
        /> : null}
        <CollaborationForm draft={props.draft} catalog={props.catalog} collaboration={props.collaboration} colors={colors} onChange={props.onChange} disabled={props.busy} />
        {props.error || issue ? <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 18 }}>{props.error || (issue ? collaborationIssueText(issue) : '')}</Text> : null}
      </ScrollView>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: outline(colors) }}>
        <Button label={ui('Cancel', '取消')} onPress={cancel} colors={colors} variant="ghost" disabled={props.busy} />
        <Button label={props.saveLabel} onPress={props.onSave} colors={colors} disabled={props.busy || Boolean(issue)} />
      </View>
    </View>
  </View>;
}
