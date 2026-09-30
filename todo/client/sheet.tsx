import { useState, type ReactNode } from 'react';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { diffLineKind, diffStats, relativeAge } from '../shared/board';
import { canAccept, canCancel, canContinue, canRetry } from '../shared/machine';
import type { Catalog, Task, TaskDiff } from '../shared/schema';
import { HostTag, projectLabel, StatusChip } from './card';
import { explain, ui } from './i18n';
import { Backdrop, Button, Dot, MONO, outline, SectionTitle, tint, type Colors } from './kit';

export interface SheetHandlers {
  onStart(): void;
  onCancel(): void;
  onRetry(): void;
  onContinue(prompt: string): Promise<boolean>;
  onAccept(): void;
  onOpenSession: (() => void) | null;
}

export function providerLabel(task: Task, catalog: Catalog | null): string {
  const [provider, ...rest] = task.provider.split('/');
  const model = rest.join('/');
  const entry = catalog?.providers.find(item => item.provider === provider);
  const modelLabel = entry?.models.find(item => item.id === model)?.label ?? model;
  return `${entry?.label ?? provider} · ${modelLabel}`;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : '—');

export function TaskSheet(props: SheetHandlers & {
  task: Task;
  hostLabel?: string | null;
  diff: TaskDiff;
  catalog: Catalog | null;
  colors: Colors;
  now: number;
  wide: boolean;
  busy: boolean;
  onClose(): void;
}) {
  const { colors, task } = props;
  const stats = diffStats(props.diff.patch);
  return <Backdrop onClose={props.onClose} align="right">
    <View style={{ width: props.wide ? 540 : '100%', height: '100%', backgroundColor: colors.surface0, borderLeftWidth: props.wide ? 1 : 0, borderLeftColor: outline(colors) }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 20, paddingRight: 52, borderBottomWidth: 1, borderBottomColor: outline(colors) }}>
        <View style={{ width: 36, height: 36, borderRadius: 12, borderWidth: 1, borderColor: outline(colors), backgroundColor: tint(colors.surface2, 0.6), alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="ListTodo" size={18} color={colors.foreground} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Text style={{ flex: 1, color: colors.foreground, fontSize: 15, fontWeight: '700', lineHeight: 20 }}>{task.title}</Text>
            <StatusChip status={task.status} colors={colors} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {props.hostLabel ? <HostTag label={props.hostLabel} colors={colors} /> : null}
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{projectLabel(task)}</Text>
            <Dot colors={colors} />
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{providerLabel(task, props.catalog)}</Text>
            <Dot colors={colors} />
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{relativeAge(task.updatedAt, props.now)}</Text>
          </View>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={ui('Close', '关闭')} onPress={props.onClose} style={{ position: 'absolute', top: 16, right: 16, padding: 6, borderRadius: 8 }}>
          <Icon name="X" size={16} color={colors.foregroundMuted} />
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 20 }}>
        {task.errorCode ? <View style={{ flexDirection: 'row', gap: 8, padding: 12, borderRadius: 12, backgroundColor: tint(colors.statusDanger, 0.12) }}>
          <Icon name="CircleAlert" size={14} color={colors.statusDanger} />
          <Text style={{ flex: 1, color: colors.statusDanger, fontSize: 12, lineHeight: 18 }}>{explain(task.errorCode, task.errorDetail)}</Text>
        </View> : null}
        <Section title={ui('Prompt', '任务内容')} colors={colors}>
          <Quote colors={colors}>{task.prompt}</Quote>
        </Section>
        {task.pendingPrompt ? <Section title={ui('Follow-up', '继续修改')} colors={colors}>
          <Quote colors={colors}>{task.pendingPrompt}</Quote>
        </Section> : null}
        <NextStep {...props} />
        <Section title={ui('Details', '详情')} colors={colors}>
          <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 12, overflow: 'hidden' }}>
            {([
              [ui('Branch', '任务分支'), task.branch ?? ui('Not created yet', '尚未创建'), true],
              [ui('Target', '目标分支'), task.targetBranch, true],
              [ui('Base', '起点'), short(task.review?.targetHead ?? task.baseCommit), true],
              [ui('Result', '成果提交'), short(task.review?.resultCommit ?? null), true],
              ...(task.mergeCommit ? [[ui('Merged as', '合并提交'), `${short(task.mergeCommit)} · ${task.mergeMethod ?? ''}`, true] as const] : []),
              [ui('Worktree', '工作树'), task.worktree ?? '—', true],
            ] as const).map(([label, value, mono], index, rows) => <View key={label} style={{ flexDirection: 'row', borderBottomWidth: index === rows.length - 1 ? 0 : 1, borderBottomColor: outline(colors) }}>
              <Text style={{ width: 104, paddingVertical: 8, paddingHorizontal: 12, color: colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
              <Text selectable numberOfLines={1} style={{ flex: 1, paddingVertical: 8, paddingRight: 12, color: colors.foreground, fontSize: 11, fontFamily: mono ? MONO : undefined, lineHeight: 18 }}>{value}</Text>
            </View>)}
          </View>
        </Section>
        <Section
          title={<>{ui('Files', '改动文件')} <Text style={{ color: tint(colors.foregroundMuted, 0.7), fontWeight: '400' }}>{props.diff.files.length}</Text>
            {props.diff.files.length > 0 ? <>  <Text style={{ color: colors.statusSuccess, fontFamily: MONO }}>+{stats.additions}</Text> <Text style={{ color: colors.statusDanger, fontFamily: MONO }}>−{stats.deletions}</Text></> : null}</>}
          colors={colors}
        >
          {props.diff.files.length === 0
            ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('No changes yet.', '还没有改动。')}</Text>
            : <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 12, overflow: 'hidden' }}>
              {props.diff.files.map((file, index) => <View key={file} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: index === props.diff.files.length - 1 ? 0 : 1, borderBottomColor: outline(colors) }}>
                <Icon name="FileCode" size={13} color={colors.foregroundMuted} />
                <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: 11, fontFamily: MONO }}>{file}</Text>
              </View>)}
            </View>}
          {props.diff.patch ? <Diff patch={props.diff.patch} truncated={props.diff.truncated} colors={colors} /> : null}
        </Section>
      </ScrollView>
    </View>
  </Backdrop>;
}

/** One panel for every status: amber while the result waits on the person, neutral otherwise. */
function NextStep(props: SheetHandlers & { task: Task; colors: Colors; busy: boolean }) {
  const { colors, task } = props;
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const review = canAccept(task.status) && Boolean(task.review);
  const text = (() => {
    switch (task.status) {
      case 'draft': return ui('Not started. Start it now, or leave it in To do for the queue.', '还没开始。现在开始，或者留在待办里等队列。');
      case 'queued': return ui('Waiting for the repository queue. One task runs per repository at a time.', '等待仓库队列。同一仓库一次只跑一个任务。');
      case 'preparing': return ui('Creating the worktree and the session.', '正在创建工作树和会话。');
      case 'running': return ui('The agent is working in its own worktree.', 'Agent 正在自己的工作树里工作。');
      case 'needs_attention': return ui('The agent is waiting for a permission decision in its session.', 'Agent 在会话里等待权限确认。');
      case 'awaiting_review': return ui(`The agent finished. Read the changes below, then merge ${task.branch ?? ''} into ${task.targetBranch}.`, `Agent 已完成。看完下面的改动后，把 ${task.branch ?? ''} 合并到 ${task.targetBranch}。`);
      case 'merge_failed': return ui('The merge did not go through. The task branch is untouched; fix the cause and accept again, or send it back.', '合并没有完成，任务分支未改动。处理原因后再验收，或者打回修改。');
      case 'needs_check': return ui('The result could not be confirmed, so nothing was merged or resent.', '无法确认成果，没有合并也没有重新派发。');
      case 'failed': return ui('The agent turn failed.', 'Agent 轮次失败。');
      case 'merging': return ui('Merging…', '正在合并…');
      case 'canceling': return ui('Stopping the session…', '正在停止会话…');
      case 'merged': return ui(`Merged into ${task.targetBranch}.`, `已合并到 ${task.targetBranch}。`);
      case 'canceled': return ui('Canceled. The worktree and branch were kept.', '已取消，工作树和分支已保留。');
    }
  })();
  const warn = review || task.status === 'needs_attention';
  const primary = review
    ? <Button label={ui('Accept and merge', '验收并合并')} icon="GitMerge" onPress={props.onAccept} colors={colors} full disabled={props.busy} />
    : task.status === 'draft'
      ? <Button label={ui('Start', '开始')} icon="Play" onPress={props.onStart} colors={colors} full disabled={props.busy} />
      : canRetry(task.status)
        ? <Button label={ui('Retry with a new session', '用新会话重试')} icon="RotateCcw" onPress={props.onRetry} colors={colors} full disabled={props.busy} />
        : task.status === 'needs_attention' && props.onOpenSession
          ? <Button label={ui('Open session', '打开会话')} icon="MessageSquare" onPress={props.onOpenSession} colors={colors} full />
          : null;
  return <View style={{ gap: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: warn ? tint(colors.statusWarning, 0.35) : outline(colors), backgroundColor: warn ? tint(colors.statusWarning, 0.05) : tint(colors.surface2, 0.4) }}>
    <Text style={{ color: task.status === 'merged' ? colors.statusSuccess : colors.foreground, fontSize: 12, lineHeight: 18 }}>{text}</Text>
    {primary}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {canContinue(task.status) ? <Button label={ui('Send back', '打回修改')} icon="CornerDownLeft" onPress={() => setComposing(value => !value)} colors={colors} variant="outline" size="xs" /> : null}
      {props.onOpenSession && task.status !== 'needs_attention' ? <Button label={ui('Open session', '打开会话')} icon="MessageSquare" onPress={props.onOpenSession} colors={colors} variant="outline" size="xs" /> : null}
      {canCancel(task.status) && task.status !== 'canceling' ? <Button label={ui('Cancel task', '取消任务')} icon="X" onPress={props.onCancel} colors={colors} variant="ghost" size="xs" disabled={props.busy} /> : null}
    </View>
    {composing && canContinue(task.status) ? <View style={{ gap: 8 }}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        multiline
        placeholder={ui('What should change? A new session picks up the same worktree.', '需要改什么？新会话会接着用同一个工作树。')}
        placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
        style={{ minHeight: 88, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: outline(colors), backgroundColor: colors.surface0, color: colors.foreground, fontSize: 13, textAlignVertical: 'top', outlineStyle: 'solid', outlineWidth: 0 }}
      />
      <Button label={ui('Send', '发送')} icon="Send" colors={colors} size="xs" disabled={props.busy || !draft.trim()} onPress={() => {
        void props.onContinue(draft).then(sent => { if (sent) { setDraft(''); setComposing(false); } });
      }} />
    </View> : null}
  </View>;
}

function Section(props: { title: ReactNode; colors: Colors; children: ReactNode }) {
  return <View style={{ gap: 8 }}>
    <SectionTitle colors={props.colors}>{props.title}</SectionTitle>
    {props.children}
  </View>;
}

function Quote(props: { colors: Colors; children: string }) {
  return <Text selectable style={{ padding: 12, borderRadius: 12, backgroundColor: props.colors.surface2, color: props.colors.foreground, fontSize: 12, lineHeight: 18 }}>{props.children}</Text>;
}

function Diff(props: { patch: string; truncated: boolean; colors: Colors }) {
  const { colors } = props;
  const color = { add: colors.statusSuccess, del: colors.statusDanger, hunk: colors.foregroundMuted, meta: colors.foregroundMuted, context: colors.foreground };
  const fill = { add: tint(colors.statusSuccess, 0.1), del: tint(colors.statusDanger, 0.1), hunk: tint(colors.surface2, 0.8), meta: 'transparent', context: 'transparent' };
  return <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 12, overflow: 'hidden', backgroundColor: colors.surface1 }}>
    <ScrollView horizontal contentContainerStyle={{ flexGrow: 1, paddingVertical: 8 }}>
      <View style={{ flexGrow: 1 }}>
        {props.patch.split('\n').map((line, index) => {
          const kind = diffLineKind(line);
          return <Text key={index} selectable style={{ paddingHorizontal: 12, color: color[kind], backgroundColor: fill[kind], fontFamily: MONO, fontSize: 11, lineHeight: 17, fontWeight: kind === 'meta' ? '600' : '400' }}>{line || ' '}</Text>;
        })}
      </View>
    </ScrollView>
    {props.truncated ? <Text style={{ padding: 8, color: colors.statusWarning, fontSize: 11, borderTopWidth: 1, borderTopColor: outline(colors) }}>{ui('Diff truncated.', 'diff 已截断。')}</Text> : null}
  </View>;
}
