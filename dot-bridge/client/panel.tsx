import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PaseoApi } from '@getpaseo/client';
import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { Pressable, Text, TextInput, View } from 'react-native';
import { currentRound, type Task } from '../shared/schema';
import { RemotePanel } from './remote';
import { WorkspaceAuthorizationPanel } from './workspace-authorization';
import { ConnectionCard } from './connection';
import { TaskDetail } from './detail';
import { TaskEditor } from './editor';
import { parseDotBridgeError, remoteStatusLabel, ui, verifyStatusLabel } from './i18n';
import { claimWaitLabel } from '../shared/claim-recovery';
import { Button, cardFill, controlFill, outline, panelFill, Pill, SectionTitle, tint, type Colors } from './kit';
import {
  TASK_STATUS_GROUPS,
  filterTasks,
  filterWorkspaces,
  formatTimeAgo,
  groupCounts,
  hasActiveFilter,
  statusTone,
  type StatusTone,
  type TaskStatusGroup,
  type WorkspaceChoice,
} from './panel-model';
import type { BridgeQuery } from './query';

export interface DotBridgePanelProps extends PluginSurfaceProps {
  rpc: PluginClientContext['rpc'];
  paseo: PaseoApi;
  query: BridgeQuery;
  /** Set in the workspace panel; null in the global surface, where a workspace is chosen first. */
  workspaceId: string | null;
}

/** Desktop content column; wider hosts still get a readable measure instead of full-bleed text. */
const CONTENT_MAX_WIDTH = 1140;
/** The workspace picker scrolls inside this height so a long list never pushes history off-screen. */
const WORKSPACE_LIST_MAX_HEIGHT = 232;

function toneColor(colors: Colors, tone: StatusTone): string {
  switch (tone) {
    case 'muted':
      return tint(colors.foregroundMuted, 0.9);
    case 'accent':
      return colors.accent;
    case 'warning':
      return colors.statusWarning;
    case 'success':
      return colors.statusSuccess;
    case 'danger':
      return colors.statusDanger;
  }
}

function groupLabel(group: TaskStatusGroup): string {
  switch (group) {
    case 'all':
      return ui('All', '全部');
    case 'active':
      return ui('In progress', '进行中');
    case 'waiting':
      return ui('Waiting for you', '待回复');
    case 'completed':
      return ui('Completed', '已完成');
    case 'failed':
      return ui('Failed / stopped', '失败/停止');
  }
}

function inputStyle(colors: Colors, compact: boolean) {
  return {
    color: colors.foreground,
    borderWidth: 1,
    borderColor: outline(colors),
    borderRadius: 9,
    paddingHorizontal: 11,
    paddingVertical: compact ? 10 : 8,
    minHeight: compact ? 44 : 36,
    fontSize: 13,
    backgroundColor: controlFill(colors, 0.72),
  } as const;
}

/** One history entry: two-line title, a small accurate status marker and a dim meta line. */
function TaskRow(props: {
  task: Task;
  colors: Colors;
  compact: boolean;
  /** Resolved workspace name; the raw id is the safe fallback in the all-workspaces scope. */
  workspaceName?: string;
  /** False in a fixed workspace panel, where the workspace is already implied by the panel. */
  showWorkspace: boolean;
  onOpen(): void;
}) {
  const { colors } = props;
  const round = currentRound(props.task);
  const localCancel = round.remoteStatus === 'stopped' && round.claim === null;
  const stalled = claimWaitLabel(round) !== null;
  const statusText = stalled ? ui('Not claimed · needs attention', '长时间未领取') : remoteStatusLabel(round.remoteStatus, { localCancel });
  const origin = props.task.remoteOrigin
    ? ui(`Remote device ${props.task.remoteOrigin.deviceId}`, `远端设备 ${props.task.remoteOrigin.deviceId}`)
    : props.task.mode === 'text'
      ? ui('Local workspace', '本地工作区')
      : ui('Historical Git task', '旧 Git 记录');
  const workspaceText = props.workspaceName ?? (props.showWorkspace ? props.task.workspaceId : null);
  const meta = [workspaceText, origin].filter(Boolean).join(' · ');
  const locale = ui<'en' | 'zh-CN'>('en', 'zh-CN');
  const updated = formatTimeAgo(props.task.updatedAt, Date.now(), locale);
  const statusColor = stalled ? colors.statusWarning : toneColor(colors, statusTone(round.remoteStatus, { localCancel }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.task.title} · ${workspaceText ? `${workspaceText} · ` : ''}${statusText} · ${updated}`}
      onPress={props.onOpen}
      style={({ pressed }) => ({
        borderWidth: 1,
        borderColor: outline(colors),
        borderRadius: 11,
        padding: 12,
        gap: 6,
        minWidth: 0,
        backgroundColor: pressed ? controlFill(colors, 0.98) : cardFill(colors),
      })}
    >
      <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: '600' }}>
        {props.task.title}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0, flexShrink: 1 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor, flexShrink: 0 }} />
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12 }}>{statusText}</Text>
        </View>
        {props.task.mode === 'git' ? (
          <Pill colors={colors} style={{ height: 22, paddingHorizontal: 8 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{verifyStatusLabel(round.verification.status)}</Text>
          </Pill>
        ) : null}
      </View>
      {/* The truncatable source text and the exact time are separate boxes so a long UUID cannot hide the time. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: tint(colors.foregroundMuted, 0.85), fontSize: 11, flexShrink: 1, minWidth: 0 }}>
          {meta}
        </Text>
        <Text style={{ color: tint(colors.foregroundMuted, 0.85), fontSize: 11, flexShrink: 0 }}>{updated}</Text>
      </View>
    </Pressable>
  );
}

function Segmented<T extends string>(props: {
  items: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange(value: T): void;
  colors: Colors;
  compact: boolean;
}) {
  const { colors, compact } = props;
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        alignSelf: 'flex-start',
        backgroundColor: controlFill(colors, 0.9),
        borderRadius: 999,
        padding: 3,
        gap: 3,
        borderWidth: 1,
        borderColor: outline(colors),
      }}
    >
      {props.items.map(item => {
        const active = item.value === props.value;
        return (
          <Pressable
            key={item.value}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: active }}
            aria-selected={active}
            onPress={() => props.onChange(item.value)}
            style={({ pressed }) => ({
              minHeight: compact ? 44 : 30,
              paddingHorizontal: 16,
              borderRadius: 999,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: active ? tint(colors.foreground, 0.16) : pressed ? controlFill(colors, 0.6) : 'transparent',
            })}
          >
            <Text style={{ color: active ? colors.foreground : colors.foregroundMuted, fontSize: 13, fontWeight: active ? '600' : '500' }}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function WorkspaceOption(props: {
  id: string | null;
  label: string;
  selected: boolean;
  colors: Colors;
  onSelect(id: string | null): void;
}) {
  const { colors } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      aria-selected={props.selected}
      onPress={() => props.onSelect(props.id)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 44,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: props.selected ? tint(colors.foreground, 0.12) : pressed ? controlFill(colors, 0.7) : 'transparent',
      })}
    >
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, fontWeight: props.selected ? '600' : '500' }}>
        {props.label}
      </Text>
      {props.selected ? <Text style={{ color: colors.accent, fontSize: 12 }}>✓</Text> : null}
    </Pressable>
  );
}

function WorkspaceSelector(props: {
  colors: Colors;
  compact: boolean;
  choices: WorkspaceChoice[];
  loading: boolean;
  error: string | null;
  selected: string | null;
  onSelect(id: string | null): void;
  onRetry(): void;
}) {
  const { colors, compact } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterWorkspaces(props.choices, query), [props.choices, query]);
  const select = (id: string | null) => {
    props.onSelect(id);
    setOpen(false);
    setQuery('');
  };
  const selectedLabel = props.selected
    ? props.choices.find(choice => choice.id === props.selected)?.label ?? props.selected
    : ui('All workspaces', '全部工作区');
  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ui('Choose workspace', '选择工作区')}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={() => setOpen(value => !value)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 48,
          paddingHorizontal: 14,
          borderRadius: 11,
          borderWidth: 1,
          borderColor: outline(colors),
          backgroundColor: pressed ? controlFill(colors, 0.98) : controlFill(colors, 0.82),
        })}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Workspace scope', '工作区范围')}</Text>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 14, fontWeight: '600' }}>{selectedLabel}</Text>
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{open ? '▲' : '▼'}</Text>
      </Pressable>
      {open ? (
        <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 11, backgroundColor: cardFill(colors), padding: 8, gap: 8 }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            accessibilityLabel={ui('Search workspaces', '搜索工作区')}
            placeholder={ui('Search workspaces', '搜索工作区')}
            placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
            style={inputStyle(colors, compact)}
          />
          {props.error ? (
            <View style={{ gap: 6 }}>
              <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{props.error}</Text>
              <Button label={ui('Retry', '重试')} colors={colors} variant="outline" size="sm" height={compact ? 44 : undefined} onPress={props.onRetry} />
            </View>
          ) : props.loading ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('Loading workspaces…', '读取工作区中…')}</Text>
          ) : filtered.length === 0 ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
              {query.trim() ? ui('No workspaces match your search.', '没有匹配的工作区。') : ui('No workspaces found.', '未找到工作区。')}
            </Text>
          ) : (
            <ScrollView style={{ maxHeight: WORKSPACE_LIST_MAX_HEIGHT }} nestedScrollEnabled>
              <View style={{ gap: 3 }}>
                {!query.trim() ? (
                  <WorkspaceOption
                    id={null}
                    label={ui('All workspaces', '全部工作区')}
                    selected={props.selected === null}
                    colors={colors}
                    onSelect={select}
                  />
                ) : null}
                {filtered.map(choice => (
                  <WorkspaceOption
                    key={choice.id}
                    id={choice.id}
                    label={choice.label}
                    selected={props.selected === choice.id}
                    colors={colors}
                    onSelect={select}
                  />
                ))}
              </View>
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** The Dot tasks panel: connection settings, task list, creation and per-task conversation and results. */
export function DotBridgePanel(props: DotBridgePanelProps) {
  const { colors } = props.theme;
  const compact = props.layout.compact;
  const [tab, setTab] = useState<'tasks' | 'connection' | 'machines'>('tasks');
  const [openId, setOpenId] = useState<string | null>(null);
  const [choices, setChoices] = useState<WorkspaceChoice[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(props.workspaceId);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceRetry, setWorkspaceRetry] = useState(0);
  const [taskQuery, setTaskQuery] = useState('');
  const [group, setGroup] = useState<TaskStatusGroup>('all');
  const [showEditor, setShowEditor] = useState(false);

  useEffect(() => {
    setSelectedWorkspace(props.workspaceId);
    setOpenId(null);
  }, [props.workspaceId]);

  // Switching scope collapses the editor: its draft belongs to one workspace and must not follow.
  useEffect(() => {
    setShowEditor(false);
  }, [selectedWorkspace]);

  useEffect(() => {
    if (props.workspaceId) return;
    let cancelled = false;
    setWorkspaceError(null);
    setWorkspaceLoading(true);
    void props.paseo.workspaces.list()
      .then(result => {
        if (cancelled) return;
        setChoices(result.entries.map(entry => ({ id: entry.id, label: entry.title || entry.name })));
      })
      .catch(error => {
        // A failed workspace list must not look like "no workspaces"; surface it with a retry.
        if (!cancelled) setWorkspaceError(parseDotBridgeError(error));
      })
      .finally(() => {
        if (!cancelled) setWorkspaceLoading(false);
      });
    return () => { cancelled = true; };
  }, [props.paseo, props.workspaceId, workspaceRetry]);

  const tasks = useQuery(props.query.tasksOptionsFor(selectedWorkspace), props.query.client);
  const list = tasks.data?.tasks ?? [];
  const workspaceNames = useMemo(() => new Map(choices.map(choice => [choice.id, choice.label])), [choices]);
  // A late create response must not open a task in a workspace the user has since switched away from.
  const selectedWorkspaceRef = useRef(selectedWorkspace);
  selectedWorkspaceRef.current = selectedWorkspace;
  // The open task is resolved from the *unfiltered* list, so a search or status filter can never
  // make an already open task disappear.
  const open = useMemo(() => list.find(task => task.id === openId) ?? null, [list, openId]);
  const filtered = useMemo(() => filterTasks(list, { query: taskQuery, group }), [list, taskQuery, group]);
  const counts = useMemo(() => groupCounts(list), [list]);
  const activeFilter = hasActiveFilter({ query: taskQuery, group });
  const tabs = [
    { value: 'tasks' as const, label: ui('Tasks', '任务') },
    { value: 'connection' as const, label: ui('Connection', '连接') },
    { value: 'machines' as const, label: ui('Machines', '多机') },
  ];

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: compact ? 12 : 24, alignItems: 'center' }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: 12, minWidth: 0 }}>
        <View
          style={{
            borderWidth: 1,
            borderColor: outline(colors),
            borderRadius: 14,
            backgroundColor: panelFill(colors),
            padding: compact ? 12 : 16,
            gap: 12,
            minWidth: 0,
          }}
        >
          <Segmented<'tasks' | 'connection' | 'machines'> items={tabs} value={tab} onChange={setTab} colors={colors} compact={compact} />
        </View>

        {tab === 'machines' ? (
          <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 14, backgroundColor: panelFill(colors), padding: compact ? 12 : 16, minWidth: 0 }}>
            <RemotePanel rpc={props.rpc} colors={colors} workspaceId={selectedWorkspace} compact={compact} />
          </View>
        ) : tab === 'connection' ? (
          <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 14, backgroundColor: panelFill(colors), padding: compact ? 12 : 16, minWidth: 0 }}>
            <ConnectionCard theme={props.theme} host={props.host} layout={props.layout} rpc={props.rpc} query={props.query} />
          </View>
        ) : open ? (
          <>
            {(open.workspaceId ?? selectedWorkspace) ? (
              <WorkspaceAuthorizationPanel key={open.workspaceId ?? selectedWorkspace!} rpc={props.rpc} colors={colors} compact={compact} workspaceId={open.workspaceId ?? selectedWorkspace!} />
            ) : null}
            <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 14, backgroundColor: panelFill(colors), padding: compact ? 12 : 16, minWidth: 0 }}>
              <TaskDetail
                colors={colors}
                rpc={props.rpc}
                query={props.query}
                task={open}
                workspaceId={open.workspaceId}
                navigation={props.navigation}
                onBack={() => setOpenId(null)}
              />
            </View>
          </>
        ) : (
          <>
            {!props.workspaceId ? (
              <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 14, backgroundColor: panelFill(colors), padding: compact ? 12 : 16, minWidth: 0 }}>
                <WorkspaceSelector
                  colors={colors}
                  compact={compact}
                  choices={choices}
                  loading={workspaceLoading}
                  error={workspaceError}
                  selected={selectedWorkspace}
                  onSelect={setSelectedWorkspace}
                  onRetry={() => setWorkspaceRetry(value => value + 1)}
                />
              </View>
            ) : null}

            {selectedWorkspace ? (
              <WorkspaceAuthorizationPanel key={selectedWorkspace} rpc={props.rpc} colors={colors} compact={compact} workspaceId={selectedWorkspace} />
            ) : null}

            <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 14, backgroundColor: panelFill(colors), overflow: 'hidden', minWidth: 0 }}>
              {selectedWorkspace ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={ui('New task', '新建任务')}
                    accessibilityState={{ expanded: showEditor }}
                    aria-expanded={showEditor}
                    onPress={() => setShowEditor(value => !value)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      minHeight: 48,
                      paddingHorizontal: compact ? 12 : 16,
                      paddingVertical: 10,
                      backgroundColor: pressed ? controlFill(colors, 0.5) : 'transparent',
                    })}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '600' }}>{ui('New task', '新建任务')}</Text>
                      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                        {ui('Chat with Dot or request code changes in this workspace', '在当前工作区与 Dot 聊天或要求改代码')}
                      </Text>
                    </View>
                    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{showEditor ? ui('Collapse', '收起') : ui('Expand', '展开')}</Text>
                  </Pressable>
                  {/* Kept mounted (hidden) so collapsing does not discard the draft or a pending operationId. */}
                  <View style={{ display: showEditor ? 'flex' : 'none', borderTopWidth: 1, borderTopColor: outline(colors), paddingHorizontal: compact ? 12 : 16, paddingTop: 12, paddingBottom: 14 }}>
                    {/* key remounts the editor per workspace, so a half-typed draft cannot be submitted elsewhere. */}
                    <TaskEditor
                      key={selectedWorkspace}
                      colors={colors}
                      compact={compact}
                      rpc={props.rpc}
                      query={props.query}
                      workspaceId={selectedWorkspace}
                      onCreated={task => {
                        if (task.workspaceId === selectedWorkspaceRef.current) setOpenId(task.id);
                        void props.query.client.invalidateQueries({ queryKey: ['dot-bridge', 'tasks'] });
                      }}
                    />
                  </View>
                </>
              ) : (
                <View style={{ padding: compact ? 12 : 16 }}>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                    {ui('Select a workspace above to create a task.', '请先在上方选择工作区，再创建任务。')}
                  </Text>
                </View>
              )}
            </View>

            <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 14, backgroundColor: panelFill(colors), padding: compact ? 12 : 16, gap: 10, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <SectionTitle colors={colors}>{ui('Task history', '任务历史')}</SectionTitle>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                  {activeFilter ? `${filtered.length} / ${list.length}` : list.length}
                </Text>
              </View>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 }}>
                <TextInput
                  value={taskQuery}
                  onChangeText={setTaskQuery}
                  accessibilityLabel={ui('Search tasks', '搜索任务')}
                  placeholder={ui('Search tasks', '搜索任务')}
                  placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
                  style={[inputStyle(colors, compact), { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0 }]}
                />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, flexShrink: 1, minWidth: 0 }} accessibilityRole="radiogroup" aria-label={ui('Filter by status', '按状态筛选')}>
                  {TASK_STATUS_GROUPS.map(value => {
                    const active = group === value;
                    return (
                      <Pressable
                        key={value}
                        accessibilityRole="radio"
                        accessibilityLabel={`${groupLabel(value)} (${counts[value]})`}
                        accessibilityState={{ checked: active }}
                        aria-checked={active}
                        onPress={() => setGroup(value)}
                        style={({ pressed }) => ({
                          minHeight: compact ? 44 : 32,
                          paddingHorizontal: 12,
                          borderRadius: 999,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderWidth: 1,
                          borderColor: active ? tint(colors.foreground, 0.22) : outline(colors),
                          backgroundColor: active ? tint(colors.foreground, 0.16) : pressed ? controlFill(colors, 0.6) : controlFill(colors, 0.5),
                        })}
                      >
                        <Text style={{ color: active ? colors.foreground : colors.foregroundMuted, fontSize: 12, fontWeight: active ? '600' : '500' }}>
                          {groupLabel(value)} · {counts[value]}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {tasks.isError ? (
                <View style={{ gap: 6 }}>
                  <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{parseDotBridgeError(tasks.error)}</Text>
                  <Button label={ui('Retry', '重试')} colors={colors} variant="outline" size="sm" height={compact ? 44 : undefined} onPress={() => { void tasks.refetch(); }} />
                </View>
              ) : tasks.isPending ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('Loading tasks…', '读取任务中…')}</Text>
              ) : tasks.data?.loadError ? (
                // A store that failed to load is not an empty list; say so and offer a retry.
                <View style={{ gap: 6 }}>
                  <Text style={{ color: colors.statusDanger, fontSize: 12 }}>
                    {ui('The saved dot-bridge state could not be loaded.', '无法加载已保存的 dot-bridge 状态。')} {tasks.data.loadError}
                  </Text>
                  <Button label={ui('Retry', '重试')} colors={colors} variant="outline" size="sm" height={compact ? 44 : undefined} onPress={() => { void tasks.refetch(); }} />
                </View>
              ) : list.length === 0 ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('No tasks yet.', '暂无任务。')}</Text>
              ) : filtered.length === 0 ? (
                <View style={{ gap: 6 }}>
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                    {ui('No tasks match the current search and filter.', '没有符合当前搜索和筛选的任务。')}
                  </Text>
                  <Button
                    label={ui('Clear filters', '清除筛选')}
                    colors={colors}
                    variant="outline"
                    size="sm"
                    height={compact ? 44 : undefined}
                    onPress={() => { setTaskQuery(''); setGroup('all'); }}
                  />
                </View>
              ) : (
                <View style={{ gap: 8, minWidth: 0 }}>
                  {filtered.map(task => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      colors={colors}
                      compact={compact}
                      workspaceName={workspaceNames.get(task.workspaceId)}
                      showWorkspace={!props.workspaceId}
                      onOpen={() => setOpenId(task.id)}
                    />
                  ))}
                </View>
              )}
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}
