import { useState } from 'react';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/react-native';
import { Text, TextInput, View } from 'react-native';
import { taskCreate } from '../shared/rpc';
import type { Task } from '../shared/schema';
import { isExplicitRejection, parseDotBridgeError, ui } from './i18n';
import { Button, outline, tint, type Colors } from './kit';
import { usePendingOperation } from './operation';
import type { BridgeQuery } from './query';

export interface TaskEditorProps {
  colors: Colors; rpc: PluginClientContext['rpc']; query: BridgeQuery;
  workspaceId: string; onCreated(task: Task): void;
  /** Compact renders larger fields and a >=44px submit target. */
  compact?: boolean;
}

export function TaskEditor(props: TaskEditorProps) {
  const { colors } = props;
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [requirement, setRequirement] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = usePendingOperation<{workspaceId: string; title: string; requirement: string; acceptance: string}>();
  const field = { color: colors.foreground, borderWidth: 1, borderColor: outline(colors), borderRadius: 9, paddingHorizontal: 11, paddingVertical: props.compact ? 12 : 9, minHeight: props.compact ? 44 : 38, fontSize: 13 } as const;
  async function create() {
    setBusy(true);
    try {
      const payload = { workspaceId: props.workspaceId, title: title.trim(), requirement: requirement.trim(), acceptance: acceptance.trim() };
      const pending = operation.begin(JSON.stringify(payload), payload);
      const { task } = await props.rpc(taskCreate, { operationId: pending.operationId, ...pending.payload, mode: 'text' });
      operation.settle(); setTitle(''); setRequirement(''); setAcceptance('');
      toast.show(ui('Task saved and queued', '任务已保存并排队'), { variant: 'success' });
      props.onCreated(task);
    } catch (error) {
      if (isExplicitRejection(error)) operation.settle();
      toast.error(parseDotBridgeError(error));
    } finally { setBusy(false); }
  }
  return <View style={{ gap: 8 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
      {ui('Chat or request code changes. File changes are applied directly to this workspace; conflicting edits are reported.', '可以聊天或要求修改代码。文件变更直接应用到当前工作区；遇到内容冲突会提示。')}
    </Text>
    <TextInput value={title} onChangeText={setTitle} accessibilityLabel={ui('Title', '标题')} placeholder={ui('Title', '标题')} placeholderTextColor={tint(colors.foregroundMuted, 0.7)} style={field} />
    <TextInput value={requirement} onChangeText={setRequirement} accessibilityLabel={ui('What should Dot do?', '希望 Dot 做什么？')} placeholder={ui('What should Dot do?', '希望 Dot 做什么？')} placeholderTextColor={tint(colors.foregroundMuted, 0.7)} multiline style={[field, { minHeight: 72, textAlignVertical: 'top' }]} />
    <TextInput value={acceptance} onChangeText={setAcceptance} accessibilityLabel={ui('Acceptance criteria', '验收条件')} placeholder={ui('Acceptance criteria', '验收条件')} placeholderTextColor={tint(colors.foregroundMuted, 0.7)} multiline style={[field, { minHeight: 48, textAlignVertical: 'top' }]} />
    <Button label={ui('Create task', '创建任务')} colors={colors} onPress={create} disabled={busy || !title.trim() || !requirement.trim()} height={props.compact ? 44 : undefined} />
  </View>;
}
