import { useEffect, useState } from 'react';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { collaborationDraftIssue, inheritCollaborationDraft, snapshotFromDraft, storedDefault, type CollaborationCatalog, type CollaborationDraft, type TaskCollaboration } from '../shared/collaboration';
import { readBranches } from '../shared/rpc';
import { taskTitle } from '../shared/title';
import type { Catalog } from '../shared/schema';
import { CollaborationForm, collaborationIssueText } from './collaboration';
import { ui } from './i18n';
import { Backdrop, Button, outline, tint, type Colors } from './kit';
import { Select } from './select';

type Rpc = PluginClientContext['rpc'];

export interface NewTaskInput {
  title: string;
  prompt: string;
  repository: string;
  projectId: string | null;
  projectName: string | null;
  targetBranch: string;
  provider: string;
  collaboration: TaskCollaboration | null;
}

export function NewTaskDialog(props: {
  /** Hosts a task can be created on; the chosen one supplies the projects, branches and agents. */
  hosts: readonly { id: string; label: string }[];
  initialHost: string;
  rpcFor(hostId: string): Rpc;
  colors: Colors;
  catalogs: Readonly<Record<string, Catalog>>;
  collaborationCatalogs: Readonly<Record<string, CollaborationCatalog>>;
  collaborationDefaults: Readonly<Record<string, TaskCollaboration | null>>;
  /** Fixed project when opened from a workspace panel. */
  scope: { repository: string; name: string } | null;
  initialRepository: string | null;
  initialProvider: string | null;
  busy: boolean;
  width: number;
  onClose(): void;
  onSubmit(input: NewTaskInput & { hostId: string }, start: boolean): void;
}) {
  const { colors } = props;
  const [hostId, setHostId] = useState(props.initialHost);
  const rpc = props.rpcFor(hostId);
  const catalog = props.catalogs[hostId] ?? null;
  const projects = catalog?.projects.filter(project => project.kind === 'git') ?? [];
  const models = catalog?.providers.flatMap(entry => entry.models.map(model => ({ value: `${entry.provider}/${model.id}`, label: model.label, group: entry.label }))) ?? [];
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [repository, setRepository] = useState(props.scope?.repository ?? props.initialRepository ?? projects[0]?.path ?? '');
  const [branches, setBranches] = useState<string[]>([]);
  const [targetBranch, setTargetBranch] = useState('');
  const [provider, setProvider] = useState(props.initialProvider ?? models[0]?.value ?? '');
  const [picker, setPicker] = useState<'host' | 'project' | 'branch' | 'agent' | null>(null);
  const [collaborationOverride, setCollaborationOverride] = useState<CollaborationDraft | null>(null);

  // A host's catalog can arrive after the dialog opens, and switching hosts brings other projects and agents:
  // keep a choice that still exists there, otherwise fall back to the first one.
  useEffect(() => {
    if (!catalog) return;
    if (!props.scope && !projects.some(item => item.path === repository)) {
      setRepository(projects.find(item => item.path === props.initialRepository)?.path ?? projects[0]?.path ?? '');
    }
    if (!models.some(item => item.value === provider)) {
      setProvider(models.find(item => item.value === props.initialProvider)?.value ?? models[0]?.value ?? '');
    }
  }, [hostId, catalog]);

  // Another machine has its own models and saved default. Drop the previous machine's override.
  useEffect(() => {
    setCollaborationOverride(null);
  }, [hostId]);

  useEffect(() => {
    if (!repository) { setBranches([]); return; }
    let live = true;
    void rpc(readBranches, { repository }).then(result => {
      if (!live) return;
      setBranches(result.branches);
      setTargetBranch(current => (current && result.branches.includes(current) ? current : result.head ?? result.branches[0] ?? ''));
    }).catch(() => { if (live) setBranches([]); });
    return () => { live = false; };
  }, [rpc, repository]);

  const project = projects.find(item => item.path === repository);
  const collaborationCatalog = props.collaborationCatalogs[hostId] ?? null;
  const collaborationDraft = collaborationOverride ?? inheritCollaborationDraft(
    storedDefault(props.collaborationDefaults, hostId),
    collaborationCatalog ?? { settings: null, rolePrompts: {} },
  );
  const collaborationProblem = collaborationDraftIssue(
    collaborationDraft,
    collaborationCatalog,
    catalog ? catalog.providers.map(entry => entry.provider) : null,
  );
  // The title may be left empty; the prompt's first line stands in for it.
  const missing = !prompt.trim() ? ui('Write what needs doing', '先写下任务内容')
    : !repository ? ui('Choose a project', '先选项目')
      : !targetBranch ? ui('Choose a branch to merge into', '先选合并到的分支')
        : !provider ? ui('Choose an agent', '先选 Agent')
          : collaborationProblem ? collaborationIssueText(collaborationProblem)
            : null;
  const ready = !missing;
  const submit = (start: boolean) => {
    const snap = snapshotFromDraft(collaborationDraft);
    if (collaborationProblem || snap.error) return;
    props.onSubmit({
      hostId, title: taskTitle(title, prompt), prompt: prompt.trim(), repository, targetBranch, provider,
      projectId: project?.projectId ?? null, projectName: props.scope?.name ?? project?.name ?? null,
      collaboration: snap.collaboration,
    }, start);
  };
  return <Backdrop onClose={props.onClose} align="center">
    <View style={{ width: Math.min(640, props.width - 24), maxHeight: '90%', borderRadius: 16, borderWidth: 1, borderColor: outline(colors), backgroundColor: colors.surface0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 4 }}>
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 13, fontWeight: '600' }}>{ui('New task', '新建任务')}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={ui('Close', '关闭')} onPress={props.onClose} style={{ padding: 4 }}>
          <Icon name="X" size={16} color={colors.foregroundMuted} />
        </Pressable>
      </View>
      <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16, gap: 14 }}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          autoFocus
          placeholder={ui('Task title (optional)', '任务标题（可不填）')}
          placeholderTextColor={tint(colors.foregroundMuted, 0.55)}
          style={{ color: colors.foreground, fontSize: 19, fontWeight: '700', paddingVertical: 6, outlineStyle: 'solid', outlineWidth: 0 }}
        />
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          multiline
          placeholder={ui('Describe what needs doing. The agent gets its own worktree and branch, and nothing merges until you accept it.', '写下要做什么。Agent 会拿到独立的工作树和分支，你验收之前不会合并。')}
          placeholderTextColor={tint(colors.foregroundMuted, 0.55)}
          style={{ minHeight: 150, padding: 12, borderRadius: 12, backgroundColor: colors.surface1, borderWidth: 1, borderColor: outline(colors), color: colors.foreground, fontSize: 13, lineHeight: 19, textAlignVertical: 'top', outlineStyle: 'solid', outlineWidth: 0 }}
        />
        {!props.scope && projects.length === 0 ? <TextInput value={repository} onChangeText={setRepository} placeholder={ui('/path/to/repository', '/仓库/路径')} placeholderTextColor={tint(colors.foregroundMuted, 0.55)} autoCapitalize="none" autoCorrect={false}
          style={{ height: 34, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: outline(colors), color: colors.foreground, fontSize: 12, outlineStyle: 'solid', outlineWidth: 0 }} /> : null}
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{ui('Collaboration', '协作')}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{ui('Used for this task. The next new task starts from this choice; tasks already in the list stay as they are.', '只用于这条任务。下次新建会沿用这次的选择，已有任务不变。')}</Text>
          <CollaborationForm draft={collaborationDraft} catalog={catalog} collaboration={collaborationCatalog} colors={colors} disabled={props.busy} onChange={setCollaborationOverride} />
        </View>
      </ScrollView>
      {picker ? <Pressable accessibilityLabel={ui('Close list', '关闭列表')} onPress={() => setPicker(null)} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 5 }} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingBottom: 14, zIndex: 10 }}>
        {props.hosts.length > 1 && !props.scope ? <Select
          label={ui('Machine', '机器')} icon="Server" colors={colors}
          value={hostId}
          options={props.hosts.map(host => ({ value: host.id, label: host.label }))}
          placeholder={ui('Choose a machine', '选择机器')}
          open={picker === 'host'} onOpenChange={open => setPicker(open ? 'host' : null)} onChange={setHostId}
        /> : null}
        {props.scope || projects.length > 0 ? <Select
          label={ui('Project', '项目')} icon="Folder" colors={colors}
          value={props.scope?.repository ?? repository}
          options={props.scope ? [{ value: props.scope.repository, label: props.scope.name }] : projects.map(item => ({ value: item.path, label: item.name }))}
          placeholder={ui('Choose a project', '选择项目')}
          disabled={Boolean(props.scope)}
          open={picker === 'project'} onOpenChange={open => setPicker(open ? 'project' : null)} onChange={setRepository}
        /> : null}
        <Select
          label={ui('Merge into', '合并到')} icon="GitBranch" colors={colors}
          value={targetBranch}
          options={branches.map(branch => ({ value: branch, label: branch }))}
          placeholder={repository ? ui('Loading branches…', '正在读取分支…') : ui('Pick a project first', '先选项目')}
          disabled={branches.length === 0}
          open={picker === 'branch'} onOpenChange={open => setPicker(open ? 'branch' : null)} onChange={setTargetBranch}
        />
        <Select
          label={ui('Agent', 'Agent')} icon="Bot" colors={colors}
          value={provider}
          options={models}
          placeholder={ui('No ready provider', '没有可用的供应商')}
          disabled={models.length === 0}
          open={picker === 'agent'} onOpenChange={open => setPicker(open ? 'agent' : null)} onChange={setProvider}
        />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: outline(colors) }}>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foregroundMuted, fontSize: 12 }}>{missing ?? ''}</Text>
        <Button label={ui('Cancel', '取消')} onPress={props.onClose} colors={colors} variant="ghost" />
        <Button label={ui('Add to To do', '加入待办')} onPress={() => submit(false)} colors={colors} variant="outline" disabled={!ready || props.busy} />
        <Button label={ui('Add and start', '添加并开始')} icon="Play" onPress={() => submit(true)} colors={colors} disabled={!ready || props.busy} />
      </View>
    </View>
  </Backdrop>;
}
