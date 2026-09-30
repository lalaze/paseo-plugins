import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PluginClientContext, PluginHostProps, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, useToast } from '@getpaseo/plugin/client/react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { BOARD_COLUMNS, groupTasks, type BoardColumn } from '../shared/board';
import { canRetry } from '../shared/machine';
import { acceptTask, cancelTask, continueTask, createTask, listTasks, readCatalog, readTask, retryTask, startQueue, startTask } from '../shared/rpc';
import type { Catalog, Task, TaskDiff } from '../shared/schema';
import { projectLabel, TaskCard, type CardAction } from './card';
import { NewTaskDialog, type NewTaskInput } from './editor';
import { parseTodoError, ui } from './i18n';
import { Button, outline, Pill, tint, type Colors } from './kit';
import { TaskSheet } from './sheet';

type Rpc = PluginClientContext['rpc'];

const EMPTY: TaskDiff = { patch: '', files: [], truncated: false };
/** Below this the four columns stop fitting and the board stacks, as it does in a workspace panel. */
const BOARD_MIN_WIDTH = 880;

/** A workspace panel pins the list, new tasks and the queue button to that workspace's repository. */
export interface TodoScope {
  repository: string;
  name: string;
}

/**
 * The last list per host and scope. The surface unmounts when you switch pages; coming back draws this at once and
 * refreshes behind it, instead of drawing an empty board and then the real one.
 */
const listCache = new Map<string, { tasks: Task[]; loadError: string | null }>();

const COLUMN_TITLE: Record<BoardColumn, readonly [string, string]> = {
  todo: ['To do', '待办'],
  inProgress: ['In progress', '进行中'],
  attention: ['Needs you', '等你处理'],
  done: ['Done', '已完成'],
};

const COLUMN_EMPTY: Record<BoardColumn, readonly [string, string]> = {
  todo: ['Nothing to do', '没有待办'],
  inProgress: ['Nothing in progress', '没有进行中的任务'],
  attention: ['Nothing needs you', '没有需要你处理的'],
  done: ['Nothing done yet', '还没有完成的任务'],
};

export function TodoPanel(props: PluginHostProps & Pick<PluginSurfaceProps, 'navigation'> & { rpc: Rpc; scope?: TodoScope }) {
  const toast = useToast();
  const colors = props.theme.colors;
  const scoped = props.scope?.repository ?? null;
  const cacheKey = `${props.host.id}\0${scoped ?? ''}`;
  const cached = listCache.get(cacheKey);
  const [tasks, setTasks] = useState<Task[]>(cached?.tasks ?? []);
  const [loaded, setLoaded] = useState(Boolean(cached));
  const [loadError, setLoadError] = useState<string | null>(cached?.loadError ?? null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [width, setWidth] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ task: Task; diff: TaskDiff } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [showCanceled, setShowCanceled] = useState(false);
  const [menu, setMenu] = useState<'project' | 'filter' | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = useCallback((error: unknown) => { toast.error(parseTodoError(error)); }, [toast]);

  const reload = useCallback(async () => {
    try {
      const listed = await props.rpc(listTasks, scoped ? { repository: scoped } : {});
      listCache.set(cacheKey, { tasks: listed.tasks, loadError: listed.loadError });
      setTasks(listed.tasks);
      setLoadError(listed.loadError);
      setLoaded(true);
      setNow(Date.now());
    } catch (error) {
      fail(error);
    }
  }, [cacheKey, fail, props.rpc, scoped]);

  useEffect(() => {
    void reload();
    void props.rpc(readCatalog, {}).then(setCatalog).catch(() => setCatalog(null));
    const timer = setInterval(() => { void reload(); }, 2000);
    return () => clearInterval(timer);
  }, [props.rpc, reload]);

  // The open sheet follows the list's polling so its status and diff stay current.
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    let live = true;
    void props.rpc(readTask, { id: openId }).then(result => { if (live) setDetail(result); }).catch(error => { if (live) fail(error); });
    return () => { live = false; };
  }, [fail, openId, props.rpc, tasks]);

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    try {
      const result = await action();
      await reload();
      return result;
    } catch (error) {
      fail(error);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const repositories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of tasks) if (!seen.has(task.repository)) seen.set(task.repository, projectLabel(task));
    return [...seen].map(([path, name]) => ({ path, name }));
  }, [tasks]);
  const visible = projectFilter ? tasks.filter(task => task.repository === projectFilter) : tasks;
  const columns = groupTasks(visible, showCanceled);
  const wide = !scoped && width >= BOARD_MIN_WIDTH;
  const openAgent = (task: Task) => (props.navigation && task.agentId ? () => props.navigation?.openAgent({ agentId: task.agentId as string }) : null);
  const openTask = detail?.task ?? tasks.find(task => task.id === openId) ?? null;

  function cardAction(task: Task): CardAction | null {
    if (task.status === 'draft') return { label: ui('Start', '开始'), icon: 'Play', onPress: () => { void run(() => props.rpc(startTask, { id: task.id })); } };
    if (task.status === 'awaiting_review' || task.status === 'merge_failed') return { label: ui('Review', '验收'), icon: 'GitMerge', onPress: () => setOpenId(task.id) };
    if (canRetry(task.status) && task.status !== 'canceled') return { label: ui('Retry', '重试'), icon: 'RotateCcw', onPress: () => { void run(() => props.rpc(retryTask, { id: task.id })); } };
    const session = openAgent(task);
    if (session && (task.status === 'running' || task.status === 'needs_attention' || task.status === 'preparing')) return { label: ui('Open session', '打开会话'), icon: 'MessageSquare', onPress: session };
    return null;
  }

  function submitNew(input: NewTaskInput, start: boolean) {
    setLastProvider(input.provider);
    void run(async () => {
      const { task } = await props.rpc(createTask, { ...input, modeId: null });
      // The task exists now; close before starting so a failed start cannot lead to a second create.
      setEditorOpen(false);
      if (start) await props.rpc(startTask, { id: task.id });
    });
  }

  const drafts = columns.todo.filter(task => task.status === 'draft').length;
  const header = (column: BoardColumn) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 26, paddingHorizontal: 2 }}>
    <View style={{ width: 3, height: 14, borderRadius: 2, backgroundColor: columnTone(column, colors) }} />
    <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '700' }}>{ui(...COLUMN_TITLE[column])}</Text>
    <Count value={columns[column].length} warn={column === 'attention'} colors={colors} />
    <View style={{ flex: 1 }} />
    {column === 'todo' && drafts > 1 ? <Button label={ui('Start all', '全部开始')} onPress={() => { void run(() => props.rpc(startQueue, { repository: scoped ?? projectFilter })); }} colors={colors} variant="ghost" size="xs" disabled={busy || Boolean(loadError)} /> : null}
  </View>;
  const cards = (column: BoardColumn) => columns[column].map(task => <TaskCard key={task.id} task={task} colors={colors} now={now} busy={busy} action={cardAction(task)} onOpen={() => setOpenId(task.id)} />);
  const empty = (column: BoardColumn, grow: boolean) => <View style={{ flex: grow ? 1 : undefined, minHeight: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: tint(colors.foregroundMuted, 0.3), backgroundColor: tint(colors.surface1, 0.35) }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui(...COLUMN_EMPTY[column])}</Text>
  </View>;

  const projectName = props.scope?.name ?? (projectFilter ? repositories.find(item => item.path === projectFilter)?.name : null) ?? ui('All projects', '全部项目');

  // Transparent so a host wallpaper shows through; cards carry their own translucent fill.
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: 'transparent' }} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, zIndex: 10 }}>
      <View>
        <Pill colors={colors} onPress={scoped ? undefined : () => setMenu(menu === 'project' ? null : 'project')} active={menu === 'project'}>
          <Icon name="Folder" size={14} color={colors.foregroundMuted} />
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: '500', maxWidth: 180 }}>{projectName}</Text>
          {scoped ? null : <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />}
        </Pill>
        {menu === 'project' ? <Menu colors={colors}>
          <MenuItem label={ui('All projects', '全部项目')} checked={!projectFilter} onPress={() => { setProjectFilter(null); setMenu(null); }} colors={colors} />
          {repositories.map(item => <MenuItem key={item.path} label={item.name} checked={projectFilter === item.path} onPress={() => { setProjectFilter(item.path); setMenu(null); }} colors={colors} />)}
        </Menu> : null}
      </View>
      <View>
        <Pill colors={colors} onPress={() => setMenu(menu === 'filter' ? null : 'filter')} active={menu === 'filter' || showCanceled}>
          <Icon name="ListFilter" size={14} color={colors.foregroundMuted} />
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '500' }}>{ui('Filter', '筛选')}</Text>
        </Pill>
        {menu === 'filter' ? <Menu colors={colors}>
          <MenuItem label={ui('Show canceled', '显示已取消')} checked={showCanceled} onPress={() => setShowCanceled(value => !value)} colors={colors} />
        </Menu> : null}
      </View>
      <View style={{ flex: 1 }} />
      <Button label={ui('New task', '新建任务')} icon="Plus" onPress={() => { setMenu(null); setEditorOpen(true); }} colors={colors} disabled={Boolean(loadError)} />
    </View>
    {loadError ? <Text style={{ marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 10, color: colors.statusDanger, backgroundColor: tint(colors.statusDanger, 0.12), fontSize: 12 }}>{parseTodoError(`todo-error:${loadError}`)}</Text> : null}

    {!loaded ? null : tasks.length === 0 ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 }}>
      <Icon name="ListTodo" size={40} color={tint(colors.foregroundMuted, 0.4)} />
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '600' }}>{ui('No tasks yet', '还没有任务')}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, textAlign: 'center', maxWidth: 360, lineHeight: 18 }}>{ui('Write down what needs doing. Each task runs in its own worktree and waits for your review before it merges.', '写下要做的事。每个任务在独立工作树里执行，验收后才会合并。')}</Text>
    </View> : wide ? <View style={{ flex: 1, minHeight: 0, flexDirection: 'row', gap: 16, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}>
      {BOARD_COLUMNS.map(column => <View key={column} style={{ flex: 1, minWidth: 0, gap: 8 }}>
        {header(column)}
        {columns[column].length === 0 ? empty(column, true) : <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12, paddingBottom: 4 }}>{cards(column)}</ScrollView>}
      </View>)}
    </View> : <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 20 }}>
      {BOARD_COLUMNS.map(column => <View key={column} style={{ gap: 8 }}>
        {header(column)}
        {columns[column].length === 0 ? empty(column, false) : cards(column)}
      </View>)}
    </ScrollView>}

    {menu ? <Pressable accessibilityLabel={ui('Close menu', '关闭菜单')} onPress={() => setMenu(null)} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 5 }} /> : null}

    {openTask ? <TaskSheet
      task={openTask}
      diff={detail?.task.id === openTask.id ? detail.diff : EMPTY}
      catalog={catalog}
      colors={colors}
      now={now}
      wide={width >= 720}
      busy={busy}
      onClose={() => setOpenId(null)}
      onStart={() => { void run(() => props.rpc(startTask, { id: openTask.id })); }}
      onCancel={() => { void run(() => props.rpc(cancelTask, { id: openTask.id })); }}
      onRetry={() => { void run(() => props.rpc(retryTask, { id: openTask.id })); }}
      onContinue={async prompt => (await run(() => props.rpc(continueTask, { id: openTask.id, prompt }))) !== null}
      onAccept={() => {
        // Send exactly the binding this sheet is showing; the server rejects it if a newer one exists.
        const review = openTask.review;
        if (review) void run(() => props.rpc(acceptTask, { id: openTask.id, review }));
      }}
      onOpenSession={openAgent(openTask)}
    /> : null}

    {editorOpen ? <NewTaskDialog
      rpc={props.rpc}
      colors={colors}
      catalog={catalog}
      scope={props.scope ?? null}
      initialRepository={projectFilter}
      initialProvider={lastProvider}
      busy={busy}
      width={width || 640}
      onClose={() => setEditorOpen(false)}
      onSubmit={submitNew}
    /> : null}
  </View>;
}

function columnTone(column: BoardColumn, colors: Colors): string {
  if (column === 'inProgress') return colors.foreground;
  if (column === 'attention') return colors.statusWarning;
  if (column === 'done') return colors.statusSuccess;
  return tint(colors.foregroundMuted, 0.6);
}

function Count(props: { value: number; warn: boolean; colors: Colors }) {
  const { colors } = props;
  const hot = props.warn && props.value > 0;
  return <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: hot ? tint(colors.statusWarning, 0.15) : colors.surface2 }}>
    <Text style={{ color: hot ? colors.statusWarning : colors.foregroundMuted, fontSize: 10, fontWeight: '700' }}>{props.value}</Text>
  </View>;
}

function Menu(props: { colors: Colors; children: ReactNode }) {
  const { colors } = props;
  return <View style={{ position: 'absolute', top: 38, left: 0, zIndex: 20, minWidth: 200, padding: 4, borderRadius: 12, borderWidth: 1, borderColor: outline(colors), backgroundColor: colors.surface1, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } }}>
    {props.children}
  </View>;
}

function MenuItem(props: { label: string; checked: boolean; onPress(): void; colors: Colors }) {
  const { colors } = props;
  return <Pressable accessibilityRole="menuitem" onPress={props.onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: pressed ? colors.surface2 : 'transparent' })}>
    <View style={{ width: 14 }}>{props.checked ? <Icon name="Check" size={14} color={colors.foreground} /> : null}</View>
    <Text style={{ color: colors.foreground, fontSize: 13 }}>{props.label}</Text>
  </Pressable>;
}
