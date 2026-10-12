import { useState } from 'react';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { relativeAge } from '../shared/board';
import { collaborationModeLabel } from '../shared/collaboration';
import { canCancel, canDelete, canEdit, type TaskStatus } from '../shared/machine';
import type { Task } from '../shared/schema';
import { explain, statusLabel, ui } from './i18n';
import { Button, outline, tint, type Colors } from './kit';

export interface CardAction {
  label: string;
  icon: string;
  onPress(): void;
}

/** Project name, or the last path segment of the repository. */
export function projectLabel(task: Task): string {
  return task.projectName ?? task.repository.split('/').filter(Boolean).pop() ?? task.repository;
}

/** Live statuses spin, the ones waiting on a person are outlined amber, outcomes are tinted. */
export function StatusChip(props: { status: TaskStatus; colors: Colors }) {
  const { colors, status } = props;
  const label = statusLabel(status);
  if (status === 'queued' || status === 'preparing' || status === 'running' || status === 'merging' || status === 'canceling') {
    return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <ActivityIndicator size={9} color={colors.foreground} />
      <Text style={{ color: colors.foreground, fontSize: 10, fontWeight: '500' }}>{label}</Text>
    </View>;
  }
  let fg = colors.foregroundMuted;
  let bg = colors.surface2;
  let border = 'transparent';
  if (status === 'awaiting_review' || status === 'needs_attention' || status === 'needs_check') {
    fg = colors.statusWarning; bg = tint(colors.statusWarning, 0.06); border = tint(colors.statusWarning, 0.45);
  } else if (status === 'merged') {
    fg = colors.statusSuccess; bg = tint(colors.statusSuccess, 0.12);
  } else if (status === 'failed' || status === 'merge_failed') {
    fg = colors.statusDanger; bg = tint(colors.statusDanger, 0.12);
  }
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: bg, borderWidth: 1, borderColor: border }}>
    {status === 'merged' ? <Icon name="Check" size={9} color={fg} /> : null}
    <Text style={{ color: fg, fontSize: 10, fontWeight: '600' }}>{label}</Text>
  </View>;
}

/** The machine a task runs on, shown when the board gathers more than one host. */
export function HostTag(props: { label: string; colors: Colors }) {
  const { colors } = props;
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: 110, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5, backgroundColor: tint(colors.foreground, 0.08) }}>
    <Icon name="Server" size={9} color={colors.foregroundMuted} />
    <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: 10, fontWeight: '600' }}>{props.label}</Text>
  </View>;
}

/** A compact marker for a task that runs a collaboration; the exact mode lives in the detail sheet. */
export function CollabTag(props: { task: Task; colors: Colors }) {
  const { colors, task } = props;
  if (!task.collaboration) return null;
  const label = ui(...collaborationModeLabel(task.collaboration.mode));
  return <View accessibilityLabel={label} style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5, backgroundColor: tint(colors.foreground, 0.08) }}>
    <Icon name="Users" size={10} color={colors.foregroundMuted} />
  </View>;
}

/** One task on the board, with a direct stop for a started collaboration. */
export function TaskCard(props: { task: Task; hostLabel?: string | null; colors: Colors; now: number; action: CardAction | null; busy: boolean; onOpen(): void; onEdit(): void; onCancel(): void; onDelete?(): void }) {
  const { colors, task } = props;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const failed = Boolean(task.errorCode) && (task.status === 'failed' || task.status === 'needs_check' || task.status === 'merge_failed');
  const editable = canEdit(task.status, Boolean(task.operationId));
  const stoppable = Boolean(task.collaboration && task.operationId && canCancel(task.status));
  const deletable = Boolean(props.onDelete && canDelete(task.status));
  const description = task.pendingPrompt ?? task.prompt;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={task.title}
    onPress={props.onOpen}
    style={({ pressed }) => ({
      padding: 10, borderRadius: 10, borderWidth: 1, backgroundColor: tint(colors.surface1, 0.72),
      borderColor: pressed ? colors.foregroundMuted : outline(colors),
      opacity: task.status === 'canceled' ? 0.6 : 1,
    })}
  >
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
      <View style={{ marginTop: 1 }}><Icon name="ListTodo" size={13} color={colors.foregroundMuted} /></View>
      <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, fontWeight: '600', lineHeight: 16 }}>{task.title}</Text>
      <StatusChip status={task.status} colors={colors} />
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 4 }}>
      {props.hostLabel ? <HostTag label={props.hostLabel} colors={colors} /> : null}
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11, maxWidth: 160 }}>{projectLabel(task)}</Text>
      <CollabTag task={task} colors={colors} />
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{relativeAge(task.updatedAt, props.now)}</Text>
    </View>
    {failed && task.errorCode ? <View style={{ marginTop: 6, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, backgroundColor: tint(colors.statusDanger, 0.12) }}>
      <Icon name="CircleAlert" size={12} color={colors.statusDanger} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.statusDanger, fontSize: 11 }}>{explain(task.errorCode)}</Text>
    </View> : description ? <Text numberOfLines={1} style={{ marginTop: 4, color: colors.foregroundMuted, fontSize: 11, lineHeight: 15 }}>{description}</Text> : null}
    {props.action || editable || stoppable || deletable ? <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: outline(colors), flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      {props.action ? <Button label={props.action.label} icon={props.action.icon} onPress={props.action.onPress} colors={colors} size="xs" disabled={props.busy} /> : null}
      {editable ? <Button label={ui('Edit task', '修改任务')} icon="Pencil" onPress={props.onEdit} colors={colors} variant="outline" size="xs" disabled={props.busy} /> : null}
      {stoppable ? <Button label={task.status === 'canceling' ? ui('Retry stop', '重试停止') : ui('Stop collaboration', '停止协作')} icon="Square" onPress={props.onCancel} colors={colors} variant="outline" size="xs" disabled={props.busy} /> : null}
      {deletable ? (confirmDelete ? <>
        <Button label={ui('Confirm delete', '确认删除')} icon="Trash2" onPress={props.onDelete!} colors={colors} variant="danger" size="xs" disabled={props.busy} />
        <Button label={ui('Cancel', '取消')} onPress={() => setConfirmDelete(false)} colors={colors} variant="ghost" size="xs" disabled={props.busy} />
      </> : <Button label={ui('Delete', '删除')} icon="Trash2" onPress={() => setConfirmDelete(true)} colors={colors} variant="ghost" size="xs" disabled={props.busy} />) : null}
    </View> : null}
  </Pressable>;
}
