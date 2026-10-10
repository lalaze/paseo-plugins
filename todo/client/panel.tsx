import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useHosts, type PluginClientContext, type PluginHostProps, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, useToast } from '@getpaseo/plugin/client/react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { BOARD_COLUMNS, groupTasks, pendingCleanup, type BoardColumn } from '../shared/board';
import {
  collaborationEditBlocksStart,
  readCollaborationDefaults,
  unavailableCatalog,
  writeCollaborationDefault,
  type CollaborationCatalog,
  type TaskCollaboration,
} from '../shared/collaboration';
import { canRetry } from '../shared/machine';
import { acceptTask, cancelTask, cleanupTask, continueTask, createTask, deleteTask, listTasks, readCatalog, readCollaborationCatalog, readTask, retryTask, startQueue, startTask, updateTaskCollaboration } from '../shared/rpc';
import type { Catalog, Task, TaskDiff } from '../shared/schema';
import { projectLabel, TaskCard, type CardAction } from './card';
import { browserCollaborationStore } from './collaboration';
import { NewTaskDialog, type NewTaskInput } from './editor';
import { createHostRegistry, hostLabel, type HostRegistry, type TodoHost } from './hosts';
import { parseTodoError, ui } from './i18n';
import { Button, outline, Pill, tint, type Colors } from './kit';
import { TaskSheet } from './sheet';

type Rpc = PluginClientContext['rpc'];

/** A task and the host it lives on; every action goes back to that host. */
export type HostedTask = Task & { hostId: string };

interface HostList {
  tasks: Task[];
  loadError: string | null;
}

const EMPTY: TaskDiff = { patch: '', files: [], truncated: false };
/** Below this the four columns stop fitting and the board stacks, as it does in a workspace panel. */
const BOARD_MIN_WIDTH = 880;
/** Below this the toolbar drops the Filter and New task labels so the row fits a phone. */
const TOOLBAR_MIN_WIDTH = 560;
/** A host that does not answer in time counts as unreachable for this round instead of holding the board back. */
const HOST_TIMEOUT = 8000;
/** The open sheet also refetches on this slow tick, so external git edits show up even when the task row never changes. */
const SHEET_REFRESH = 15_000;
const NO_HOSTS = createHostRegistry();

/** A workspace panel pins the list, new tasks and the queue button to that workspace's repository. */
export interface TodoScope {
  repository: string;
  name: string;
}

/**
 * The last list per host and scope. The surface unmounts when you switch pages; coming back draws this at once and
 * refreshes behind it, instead of drawing an empty board and then the real one.
 */
const listCache = new Map<string, HostList>();

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

/** Same load state and the same task ids with the same timestamps, in the same order: the board can keep the old object. */
function sameList(previous: HostList | undefined, next: HostList): previous is HostList {
  if (!previous || previous.loadError !== next.loadError || previous.tasks.length !== next.tasks.length) return false;
  return previous.tasks.every((task, index) => {
    const other = next.tasks[index];
    return task.id === other.id && task.updatedAt === other.updatedAt;
  });
}

/** A host that does not answer is marked unreachable for this round instead of holding the board. */
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(ui('The host did not answer in time', '主机响应超时'))), HOST_TIMEOUT);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The Tasks board. On the sidebar page it gathers every connected host that runs this plugin; in a workspace panel
 * (`scope`) it shows only this host's project.
 */
export function TodoPanel(props: PluginHostProps & Pick<PluginSurfaceProps, 'navigation'> & { rpc: Rpc; scope?: TodoScope; registry?: HostRegistry }) {
  const toast = useToast();
  const colors = props.theme.colors;
  const scoped = props.scope?.repository ?? null;
  const registry = scoped ? NO_HOSTS : props.registry ?? NO_HOSTS;
  const registered = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const appHosts = useHosts();

  // This host first, then every other host whose copy of the plugin has registered, named as the app names them.
  const hosts = useMemo<TodoHost[]>(() => {
    const self: TodoHost = { id: props.host.id, label: props.host.label, rpc: props.rpc };
    const others = registered.filter(host => host.id !== self.id).map(host => ({ ...host, label: hostLabel(host, appHosts) }));
    return [self, ...others.sort((a, b) => a.label.localeCompare(b.label))];
  }, [appHosts, props.host.id, props.host.label, props.rpc, registered]);
  const hostKey = hosts.map(host => host.id).join('\0');
  const multi = hosts.length > 1;
  const hostOf = (id: string) => hosts.find(host => host.id === id) ?? hosts[0];

  const [lists, setLists] = useState<Record<string, HostList>>(() => {
    const initial: Record<string, HostList> = {};
    for (const host of hosts) {
      const cached = listCache.get(`${host.id}\0${scoped ?? ''}`);
      if (cached) initial[host.id] = cached;
    }
    return initial;
  });
  const [unreachable, setUnreachable] = useState<Record<string, string>>({});
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});
  const [width, setWidth] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<{ hostId: string; id: string } | null>(null);
  const [detail, setDetail] = useState<{ hostId: string; task: Task; diff: TaskDiff } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [hostFilter, setHostFilter] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [showCanceled, setShowCanceled] = useState(false);
  const [menu, setMenu] = useState<'host' | 'project' | 'filter' | null>(null);
  const [busy, setBusy] = useState(false);
  const [collabCatalogs, setCollabCatalogs] = useState<Record<string, CollaborationCatalog>>({});
  const [collaborationDefaults, setCollaborationDefaults] = useState(() => readCollaborationDefaults(browserCollaborationStore()));
  const [unsavedCollab, setUnsavedCollab] = useState<{ hostId: string; id: string } | null>(null);

  const fail = useCallback((error: unknown) => { toast.error(parseTodoError(error)); }, [toast]);

  // Each host is asked on its own, so a slow or offline host never holds the others back.
  const inflight = useRef(new Set<string>());
  const fetchHost = useCallback(async (host: TodoHost, force = false) => {
    if (inflight.current.has(host.id) && !force) return;
    inflight.current.add(host.id);
    try {
      const listed = await withTimeout(host.rpc(listTasks, scoped ? { repository: scoped } : {}));
      const next = { tasks: listed.tasks, loadError: listed.loadError };
      const key = `${host.id}\0${scoped ?? ''}`;
      const kept = sameList(listCache.get(key), next) ? listCache.get(key) as HostList : next;
      listCache.set(key, kept);
      setLists(previous => (previous[host.id] === kept ? previous : { ...previous, [host.id]: kept }));
      setUnreachable(previous => {
        if (!(host.id in previous)) return previous;
        const { [host.id]: _gone, ...rest } = previous;
        return rest;
      });
      setNow(Date.now());
    } catch (error) {
      setUnreachable(previous => ({ ...previous, [host.id]: parseTodoError(error) }));
      // An unreachable host still counts as answered, so it cannot keep the board from drawing.
      setLists(previous => (host.id in previous ? previous : { ...previous, [host.id]: { tasks: [], loadError: null } }));
    } finally {
      inflight.current.delete(host.id);
    }
  }, [scoped]);

  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  useEffect(() => {
    const poll = () => { for (const host of hostsRef.current) void fetchHost(host); };
    poll();
    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [fetchHost, hostKey]);

  // Each host's projects and providers are read once per visit to the page.
  useEffect(() => {
    for (const host of hostsRef.current) {
      void withTimeout(host.rpc(readCatalog, {}))
        .then(catalog => setCatalogs(previous => ({ ...previous, [host.id]: catalog })))
        .catch(() => undefined);
      void withTimeout(host.rpc(readCollaborationCatalog, {}))
        .then(catalog => setCollabCatalogs(previous => ({ ...previous, [host.id]: catalog })))
        .catch(error => setCollabCatalogs(previous => ({ ...previous, [host.id]: unavailableCatalog(parseTodoError(error)) })));
    }
  }, [hostKey]);

  const located = useMemo<HostedTask[]>(
    () => hosts.flatMap(host => (lists[host.id]?.tasks ?? []).map(task => ({ ...task, hostId: host.id }))),
    [hosts, lists],
  );
  const answered = hosts.every(host => host.id in lists);
  const openListed = open ? located.find(task => task.hostId === open.hostId && task.id === open.id) : undefined;

  // The open sheet refetches when the open task itself changes; a slow tick catches edits the row cannot see.
  useEffect(() => {
    if (!open) { setDetail(null); return; }
    const host = hostsRef.current.find(item => item.id === open.hostId);
    if (!host) return;
    let live = true;
    const load = () => {
      void host.rpc(readTask, { id: open.id }).then(result => { if (live) setDetail({ hostId: host.id, ...result }); }).catch(error => { if (live) fail(error); });
    };
    load();
    const timer = setInterval(load, SHEET_REFRESH);
    return () => { live = false; clearInterval(timer); };
  }, [fail, open, openListed?.updatedAt]);

  async function run<T>(host: TodoHost, action: (rpc: Rpc) => Promise<T>): Promise<T | null> {
    setBusy(true);
    try {
      const result = await action(host.rpc);
      await fetchHost(host, true);
      return result;
    } catch (error) {
      fail(error);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const labelOf = (hostId: string) => hostOf(hostId).label;
  const inHost = hostFilter ? located.filter(task => task.hostId === hostFilter) : located;
  const projects = useMemo(() => {
    const seen = new Map<string, { key: string; hostId: string; repository: string; name: string }>();
    for (const task of inHost) {
      const key = `${task.hostId}\0${task.repository}`;
      if (!seen.has(key)) seen.set(key, { key, hostId: task.hostId, repository: task.repository, name: projectLabel(task) });
    }
    return [...seen.values()];
  }, [inHost]);
  const project = projects.find(item => item.key === projectFilter) ?? null;
  const visible = project ? inHost.filter(task => task.hostId === project.hostId && task.repository === project.repository) : inHost;
  const columns = groupTasks(visible, showCanceled);
  const wide = !scoped && width >= BOARD_MIN_WIDTH;
  const compact = width < TOOLBAR_MIN_WIDTH;
  const openAgent = (task: HostedTask) => (props.navigation && task.agentId
    ? () => props.navigation?.openAgent({ agentId: task.agentId as string, serverId: task.hostId })
    : null);
  const openTask: HostedTask | null = detail && open && detail.hostId === open.hostId && detail.task.id === open.id
    ? { ...detail.task, hostId: detail.hostId }
    : (open ? located.find(task => task.hostId === open.hostId && task.id === open.id) ?? null : null);
  const loadErrors = hosts.flatMap(host => {
    const code = lists[host.id]?.loadError;
    return code ? [{ host, text: parseTodoError(`todo-error:${code}`) }] : [];
  });
  const selfBlocked = Boolean(lists[hosts[0].id]?.loadError);
  const unsavedStart = ui('Save or cancel the collaboration edits before starting.', '先保存或取消协作设置的修改，再开始。');

  /** Remember this task's collaboration so the next new task on this machine starts there. */
  function rememberCollaboration(hostId: string, collaboration: TaskCollaboration | null) {
    const store = browserCollaborationStore();
    if (!store) return;
    try {
      writeCollaborationDefault(store, hostId, collaboration);
      setCollaborationDefaults(readCollaborationDefaults(store));
    } catch {
      // The task is already saved. Missing the next starting point does not undo it.
    }
  }

  function startBlocked(task: { hostId: string; id: string }): boolean {
    if (!collaborationEditBlocksStart(unsavedCollab, task)) return false;
    toast.error(unsavedStart);
    return true;
  }

  function cardAction(task: HostedTask): CardAction | null {
    const host = hostOf(task.hostId);
    if (task.status === 'draft') return { label: ui('Start', '开始'), icon: 'Play', onPress: () => { if (!startBlocked(task)) void run(host, rpc => rpc(startTask, { id: task.id })); } };
    const sessionPending = Boolean(task.collaboration) && (task.collaborationAcceptance === 'pending' || task.collaborationPhase === 'awaiting_acceptance');
    const session = openAgent(task);
    if (sessionPending && session && task.status === 'awaiting_review') return { label: ui('Open session', '打开会话'), icon: 'MessageSquare', onPress: session };
    if (task.status === 'awaiting_review' || task.status === 'merge_failed') return { label: ui('Review', '验收'), icon: 'GitMerge', onPress: () => setOpen({ hostId: task.hostId, id: task.id }) };
    if (canRetry(task.status) && task.status !== 'canceled') return { label: ui('Retry', '重试'), icon: 'RotateCcw', onPress: () => { void run(host, rpc => rpc(retryTask, { id: task.id })); } };
    if (pendingCleanup(task)) return { label: ui('Clean up', '清理'), icon: 'Archive', onPress: () => { void run(host, rpc => rpc(cleanupTask, { id: task.id })); } };
    if (session && (task.status === 'running' || task.status === 'needs_attention' || task.status === 'preparing')) return { label: ui('Open session', '打开会话'), icon: 'MessageSquare', onPress: session };
    return null;
  }

  function submitNew(input: NewTaskInput & { hostId: string }, start: boolean) {
    setLastProvider(input.provider);
    const { hostId, ...task } = input;
    void run(hostOf(hostId), async rpc => {
      const created = await rpc(createTask, { ...task, modeId: null });
      rememberCollaboration(hostId, task.collaboration);
      // The task exists now; close before starting so a failed start cannot lead to a second create.
      setEditorOpen(false);
      if (start) await rpc(startTask, { id: created.task.id });
    });
  }

  function deleteTaskAction(host: TodoHost, id: string) {
    void run(host, rpc => rpc(deleteTask, { id })).then(result => {
      if (result && open && open.id === id) {
        setUnsavedCollab(current => current && current.hostId === host.id && current.id === id ? null : current);
        setOpen(null);
        setDetail(null);
      }
    });
  }

  function startAll() {
    const targets = project ? [hostOf(project.hostId)] : hostFilter ? [hostOf(hostFilter)] : hosts;
    let skipped = false;
    for (const host of targets) {
      const drafts = (lists[host.id]?.tasks ?? []).filter(task => task.status === 'draft');
      if (drafts.length === 0) continue;
      if (unsavedCollab && unsavedCollab.hostId === host.id && drafts.some(task => task.id === unsavedCollab.id)) {
        skipped = true;
        continue;
      }
      void run(host, rpc => rpc(startQueue, { repository: scoped ?? project?.repository ?? null }));
    }
    if (skipped) toast.error(unsavedStart);
  }

  const drafts = columns.todo.filter(task => task.status === 'draft').length;
  const header = (column: BoardColumn) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 26, paddingHorizontal: 2 }}>
    <View style={{ width: 3, height: 14, borderRadius: 2, backgroundColor: columnTone(column, colors) }} />
    <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '700' }}>{ui(...COLUMN_TITLE[column])}</Text>
    <Count value={columns[column].length} warn={column === 'attention'} colors={colors} />
    <View style={{ flex: 1 }} />
    {column === 'todo' && drafts > 1 ? <Button label={ui('Start all', '全部开始')} onPress={startAll} colors={colors} variant="ghost" size="xs" disabled={busy} /> : null}
  </View>;
  const cards = (column: BoardColumn) => columns[column].map(task => <TaskCard
    key={`${task.hostId}:${task.id}`}
    task={task}
    hostLabel={multi ? labelOf(task.hostId) : null}
    colors={colors}
    now={now}
    busy={busy}
    action={cardAction(task)}
    onOpen={() => setOpen({ hostId: task.hostId, id: task.id })}
    onCancel={() => { void run(hostOf(task.hostId), rpc => rpc(cancelTask, { id: task.id })); }}
    onDelete={() => deleteTaskAction(hostOf(task.hostId), task.id)}
  />);
  // A wide column needs a lane to scroll. It has no border: the cards already have one.
  const lane = { borderRadius: 14, backgroundColor: tint(colors.surface1, 0.22) } as const;
  const empty = (column: BoardColumn, centered = false) => <Text style={{ color: colors.foregroundMuted, fontSize: 12, paddingVertical: 4, paddingHorizontal: 2, textAlign: centered ? 'center' : 'left' }}>{ui(...COLUMN_EMPTY[column])}</Text>;

  const hostName = hostFilter ? labelOf(hostFilter) : ui('All machines', '全部机器');
  const projectName = props.scope?.name ?? (project ? project.name : ui('All projects', '全部项目'));
  const editorHost = project?.hostId ?? hostFilter ?? hosts[0].id;

  // Transparent so a host wallpaper shows through; cards carry their own translucent fill.
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: 'transparent' }} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, zIndex: 10 }}>
      {multi ? <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Pill colors={colors} onPress={() => setMenu(menu === 'host' ? null : 'host')} active={menu === 'host'} style={{ flexShrink: 1 }}>
          <Icon name="Server" size={14} color={colors.foregroundMuted} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: 13, fontWeight: '500', maxWidth: 180 }}>{hostName}</Text>
          <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
        </Pill>
        {menu === 'host' ? <Menu colors={colors}>
          <MenuItem label={ui('All machines', '全部机器')} checked={!hostFilter} onPress={() => { setHostFilter(null); setProjectFilter(null); setMenu(null); }} colors={colors} />
          {hosts.map(host => <MenuItem
            key={host.id}
            label={host.label}
            note={unreachable[host.id] ? ui('unreachable', '连不上') : null}
            checked={hostFilter === host.id}
            onPress={() => { setHostFilter(host.id); setProjectFilter(null); setMenu(null); }}
            colors={colors}
          />)}
        </Menu> : null}
      </View> : null}
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Pill colors={colors} onPress={scoped ? undefined : () => setMenu(menu === 'project' ? null : 'project')} active={menu === 'project'} style={{ flexShrink: 1 }}>
          <Icon name="Folder" size={14} color={colors.foregroundMuted} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: 13, fontWeight: '500', maxWidth: 180 }}>{projectName}</Text>
          {scoped ? null : <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />}
        </Pill>
        {menu === 'project' ? <Menu colors={colors}>
          <MenuItem label={ui('All projects', '全部项目')} checked={!project} onPress={() => { setProjectFilter(null); setMenu(null); }} colors={colors} />
          {projects.map(item => <MenuItem
            key={item.key}
            label={item.name}
            note={multi && !hostFilter ? labelOf(item.hostId) : null}
            checked={project?.key === item.key}
            onPress={() => { setProjectFilter(item.key); setMenu(null); }}
            colors={colors}
          />)}
        </Menu> : null}
      </View>
      <View>
        <Pill colors={colors} onPress={() => setMenu(menu === 'filter' ? null : 'filter')} active={menu === 'filter' || showCanceled} label={ui('Filter', '筛选')}>
          <Icon name="ListFilter" size={14} color={colors.foregroundMuted} />
          {compact ? null : <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '500' }}>{ui('Filter', '筛选')}</Text>}
        </Pill>
        {menu === 'filter' ? <Menu colors={colors}>
          <MenuItem label={ui('Show canceled', '显示已取消')} checked={showCanceled} onPress={() => setShowCanceled(value => !value)} colors={colors} />
        </Menu> : null}
      </View>
      <View style={{ flex: 1 }} />
      {/* With no tasks the centre tile creates one; the toolbar button joins once there is a board. */}
      {located.length > 0 ? <Button label={ui('New task', '新建任务')} icon="Plus" iconOnly={compact} onPress={() => { setMenu(null); setEditorOpen(true); }} colors={colors} /> : null}
    </View>
    {loadErrors.map(({ host, text }) => <Text key={host.id} style={{ marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 10, color: colors.statusDanger, backgroundColor: tint(colors.statusDanger, 0.12), fontSize: 12 }}>
      {multi ? `${host.label}: ${text}` : text}
    </Text>)}

    {located.length === 0 ? (!answered ? null : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ui('New task', '新建任务')}
        disabled={selfBlocked && !multi}
        onPress={() => { setMenu(null); setEditorOpen(true); }}
        style={({ pressed }) => ({
          width: 440, maxWidth: '100%', alignItems: 'center', gap: 10, paddingVertical: 36, paddingHorizontal: 28, borderRadius: 20,
          borderWidth: 1.5, borderStyle: 'dashed', borderColor: tint(colors.foreground, pressed ? 0.45 : 0.22),
          backgroundColor: tint(colors.surface1, pressed ? 0.75 : 0.55), opacity: selfBlocked && !multi ? 0.5 : 1,
        })}
      >
        <View style={{ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.foreground, marginBottom: 6 }}>
          <Icon name="Plus" size={30} color={colors.surface0} />
        </View>
        <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: '700' }}>{ui('New task', '新建任务')}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12, textAlign: 'center', lineHeight: 18 }}>{ui('Write down what needs doing. Each task runs in its own worktree and waits for your review before it merges.', '写下要做的事。每个任务在独立工作树里执行，验收后才会合并。')}</Text>
      </Pressable>
    </View>) : wide ? <View style={{ flex: 1, minHeight: 0, flexDirection: 'row', gap: 16, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}>
      {BOARD_COLUMNS.map(column => <View key={column} style={{ flex: 1, minWidth: 0, gap: 8 }}>
        {header(column)}
        <View style={[lane, { flex: 1, minHeight: 0, overflow: 'hidden' }]}>
          {columns[column].length === 0 ? <View style={{ flex: 1, minHeight: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 }}>{empty(column, true)}</View> : <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10, padding: 8 }}>{cards(column)}</ScrollView>}
        </View>
      </View>)}
    </View> : <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 18 }}>
      {BOARD_COLUMNS.map(column => <View key={column} style={{ gap: 8 }}>
        {header(column)}
        {columns[column].length === 0 ? empty(column) : <View style={{ gap: 10 }}>{cards(column)}</View>}
      </View>)}
    </ScrollView>}

    {menu ? <Pressable accessibilityLabel={ui('Close menu', '关闭菜单')} onPress={() => setMenu(null)} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 5 }} /> : null}

    {openTask ? (() => {
      const host = hostOf(openTask.hostId);
      return <TaskSheet
        task={openTask}
        hostLabel={multi ? host.label : null}
        diff={detail && detail.hostId === openTask.hostId && detail.task.id === openTask.id ? detail.diff : EMPTY}
        catalog={catalogs[host.id] ?? null}
        collaborationCatalog={collabCatalogs[host.id] ?? null}
        colors={colors}
        now={now}
        wide={width >= 720}
        busy={busy}
        onClose={() => {
          setUnsavedCollab(current => current && current.hostId === openTask.hostId && current.id === openTask.id ? null : current);
          setOpen(null);
        }}
        onCollaborationDirty={dirty => setUnsavedCollab(dirty ? { hostId: openTask.hostId, id: openTask.id } : current => current && current.hostId === openTask.hostId && current.id === openTask.id ? null : current)}
        onSaveCollaboration={async (collaboration: TaskCollaboration | null) => (await run(host, rpc => rpc(updateTaskCollaboration, { id: openTask.id, collaboration }))) !== null}
        onStart={() => { if (!startBlocked(openTask)) void run(host, rpc => rpc(startTask, { id: openTask.id })); }}
        onCancel={() => { void run(host, rpc => rpc(cancelTask, { id: openTask.id })); }}
        onDelete={() => deleteTaskAction(host, openTask.id)}
        onRetry={() => { void run(host, rpc => rpc(retryTask, { id: openTask.id })); }}
        onCleanup={() => { void run(host, rpc => rpc(cleanupTask, { id: openTask.id })); }}
        onContinue={async prompt => (await run(host, rpc => rpc(continueTask, { id: openTask.id, prompt }))) !== null}
        onAccept={() => {
          // Send exactly the binding this sheet is showing; the server rejects it if a newer one exists.
          const review = openTask.review;
          if (review) void run(host, rpc => rpc(acceptTask, { id: openTask.id, review }));
        }}
        onOpenSession={openAgent(openTask)}
      />;
    })() : null}

    {editorOpen ? <NewTaskDialog
      hosts={hosts.map(host => ({ id: host.id, label: host.label }))}
      initialHost={editorHost}
      rpcFor={hostId => hostOf(hostId).rpc}
      colors={colors}
      catalogs={catalogs}
      collaborationCatalogs={collabCatalogs}
      collaborationDefaults={collaborationDefaults}
      scope={props.scope ?? null}
      initialRepository={project?.repository ?? null}
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
  return <View style={{ position: 'absolute', top: 38, left: 0, zIndex: 20, minWidth: 220, padding: 4, borderRadius: 12, borderWidth: 1, borderColor: outline(colors), backgroundColor: colors.surface1, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } }}>
    {props.children}
  </View>;
}

function MenuItem(props: { label: string; note?: string | null; checked: boolean; onPress(): void; colors: Colors }) {
  const { colors } = props;
  return <Pressable accessibilityRole="menuitem" onPress={props.onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: pressed ? colors.surface2 : 'transparent' })}>
    <View style={{ width: 14 }}>{props.checked ? <Icon name="Check" size={14} color={colors.foreground} /> : null}</View>
    <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: 13 }}>{props.label}</Text>
    {props.note ? <Text numberOfLines={1} style={{ maxWidth: 120, color: colors.foregroundMuted, fontSize: 12 }}>{props.note}</Text> : null}
  </Pressable>;
}
