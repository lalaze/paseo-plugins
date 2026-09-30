import { useEffect, useState, type ReactNode } from 'react';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { readBranches } from '../shared/rpc';
import type { Catalog } from '../shared/schema';
import { ui } from './i18n';
import { Backdrop, Button, outline, SectionTitle, tint, type Colors } from './kit';

type Rpc = PluginClientContext['rpc'];

export interface NewTaskInput {
  title: string;
  prompt: string;
  repository: string;
  projectId: string | null;
  projectName: string | null;
  targetBranch: string;
  provider: string;
}

export function NewTaskDialog(props: {
  rpc: Rpc;
  colors: Colors;
  catalog: Catalog | null;
  /** Fixed project when opened from a workspace panel. */
  scope: { repository: string; name: string } | null;
  initialRepository: string | null;
  initialProvider: string | null;
  busy: boolean;
  width: number;
  onClose(): void;
  onSubmit(input: NewTaskInput, start: boolean): void;
}) {
  const { colors } = props;
  const projects = props.catalog?.projects.filter(project => project.kind === 'git') ?? [];
  const models = props.catalog?.providers.flatMap(entry => entry.models.map(model => ({ value: `${entry.provider}/${model.id}`, label: `${entry.label} · ${model.label}` }))) ?? [];
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [repository, setRepository] = useState(props.scope?.repository ?? props.initialRepository ?? projects[0]?.path ?? '');
  const [branches, setBranches] = useState<string[]>([]);
  const [targetBranch, setTargetBranch] = useState('');
  const [provider, setProvider] = useState(props.initialProvider ?? models[0]?.value ?? '');

  // The catalog can arrive after the dialog opens.
  const firstModel = models[0]?.value ?? '';
  useEffect(() => {
    if (!provider && firstModel) setProvider(firstModel);
  }, [firstModel, provider]);

  useEffect(() => {
    if (!repository) { setBranches([]); return; }
    let live = true;
    void props.rpc(readBranches, { repository }).then(result => {
      if (!live) return;
      setBranches(result.branches);
      setTargetBranch(current => (current && result.branches.includes(current) ? current : result.head ?? result.branches[0] ?? ''));
    }).catch(() => { if (live) setBranches([]); });
    return () => { live = false; };
  }, [props.rpc, repository]);

  const project = projects.find(item => item.path === repository);
  const ready = Boolean(title.trim() && prompt.trim() && repository && targetBranch && provider);
  const submit = (start: boolean) => props.onSubmit({
    title: title.trim(), prompt: prompt.trim(), repository, targetBranch, provider,
    projectId: project?.projectId ?? null, projectName: props.scope?.name ?? project?.name ?? null,
  }, start);

  return <Backdrop onClose={props.onClose} align="center">
    <View style={{ width: Math.min(640, props.width - 24), maxHeight: '90%', borderRadius: 16, borderWidth: 1, borderColor: outline(colors), backgroundColor: colors.surface0, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 4 }}>
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 13, fontWeight: '600' }}>{ui('New task', '新建任务')}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={ui('Close', '关闭')} onPress={props.onClose} style={{ padding: 4 }}>
          <Icon name="X" size={16} color={colors.foregroundMuted} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16, gap: 14 }}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          autoFocus
          placeholder={ui('Task title', '任务标题')}
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
        {props.scope ? null : <Picker label={ui('Project', '项目')} colors={colors}>
          {projects.length === 0
            ? <TextInput value={repository} onChangeText={setRepository} placeholder={ui('/path/to/repository', '/仓库/路径')} placeholderTextColor={tint(colors.foregroundMuted, 0.55)} autoCapitalize="none" autoCorrect={false}
              style={{ flex: 1, height: 32, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: outline(colors), color: colors.foreground, fontSize: 12, outlineStyle: 'solid', outlineWidth: 0 }} />
            : projects.map(item => <Chip key={item.projectId} icon="Folder" label={item.name} selected={repository === item.path} onPress={() => setRepository(item.path)} colors={colors} />)}
        </Picker>}
        <Picker label={ui('Merge into', '合并到')} colors={colors}>
          {branches.length === 0
            ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{repository ? ui('Loading branches…', '正在读取分支…') : ui('Pick a project first.', '先选项目。')}</Text>
            : branches.map(branch => <Chip key={branch} icon="GitBranch" label={branch} selected={targetBranch === branch} onPress={() => setTargetBranch(branch)} colors={colors} />)}
        </Picker>
        <Picker label={ui('Agent', 'Agent')} colors={colors}>
          {models.length === 0
            ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('No ready provider.', '没有可用的供应商。')}</Text>
            : models.map(model => <Chip key={model.value} icon="Bot" label={model.label} selected={provider === model.value} onPress={() => setProvider(model.value)} colors={colors} />)}
        </Picker>
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: outline(colors) }}>
        <Button label={ui('Cancel', '取消')} onPress={props.onClose} colors={colors} variant="ghost" />
        <Button label={ui('Add to To do', '加入待办')} onPress={() => submit(false)} colors={colors} variant="outline" disabled={!ready || props.busy} />
        <Button label={ui('Add and start', '添加并开始')} icon="Play" onPress={() => submit(true)} colors={colors} disabled={!ready || props.busy} />
      </View>
    </View>
  </Backdrop>;
}

function Picker(props: { label: string; colors: Colors; children: ReactNode }) {
  return <View style={{ gap: 8 }}>
    <SectionTitle colors={props.colors}>{props.label}</SectionTitle>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{props.children}</View>
  </View>;
}

function Chip(props: { label: string; icon: string; selected: boolean; onPress(): void; colors: Colors }) {
  const { colors } = props;
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: props.selected }} onPress={props.onPress} style={{
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 11, borderRadius: 999, borderWidth: 1,
    borderColor: props.selected ? tint(colors.foreground, 0.55) : 'transparent',
    backgroundColor: props.selected ? tint(colors.foreground, 0.1) : colors.surface2,
  }}>
    <Icon name={props.icon} size={12} color={props.selected ? colors.foreground : colors.foregroundMuted} />
    <Text style={{ color: props.selected ? colors.foreground : colors.foregroundMuted, fontSize: 12, fontWeight: props.selected ? '600' : '400' }}>{props.label}</Text>
  </Pressable>;
}
