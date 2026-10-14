import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PaseoApi } from '@getpaseo/client';
import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { Pressable, Text, View } from 'react-native';
import { currentRound, type Task } from '../shared/schema';
import { RemotePanel } from './remote';
import { WorkspaceAuthorizationPanel } from './workspace-authorization';
import { ConnectionCard } from './connection';
import { TaskDetail } from './detail';
import { TaskEditor } from './editor';
import { parseDotBridgeError, remoteStatusLabel, ui, verifyStatusLabel } from './i18n';
import { Button, outline, Pill, SectionTitle, tint, type Colors } from './kit';
import type { BridgeQuery } from './query';

interface WorkspaceChoice {
  id: string;
  label: string;
}

export interface DotBridgePanelProps extends PluginSurfaceProps {
  rpc: PluginClientContext['rpc'];
  paseo: PaseoApi;
  query: BridgeQuery;
  /** Set in the workspace panel; null in the global surface, where a workspace is chosen first. */
  workspaceId: string | null;
}

function TaskRow(props: { task: Task; colors: Colors; onOpen(): void }) {
  const { colors } = props;
  const round = currentRound(props.task);
  const localCancel = round.remoteStatus === 'stopped' && round.claim === null;
  return (
    <Pressable onPress={props.onOpen} style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 10, padding: 10, gap: 4 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>{props.task.title}</Text>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        <Pill colors={colors}><Text style={{ color: colors.foreground, fontSize: 11 }}>{remoteStatusLabel(round.remoteStatus, { localCancel })}</Text></Pill>
        {props.task.mode === 'git' ? <Pill colors={colors}><Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{verifyStatusLabel(round.verification.status)}</Text></Pill> : null}
        <Text style={{ color: tint(colors.foregroundMuted, 0.8), fontSize: 11, alignSelf: 'center' }}>{props.task.remoteOrigin ? '远端设备 ' + props.task.remoteOrigin.deviceId : props.task.mode === 'text' ? ui('Local workspace', '本地工作区') : ui('Historical Git task', '旧 Git 记录')}</Text>
      </View>
    </Pressable>
  );
}

/** The Dot tasks panel: connection settings, task list, creation and per-task conversation and results. */
export function DotBridgePanel(props: DotBridgePanelProps) {
  const { colors } = props.theme;
  const [tab, setTab] = useState<'tasks' | 'connection' | 'machines'>('tasks');
  const [openId, setOpenId] = useState<string | null>(null);
  const [choices, setChoices] = useState<WorkspaceChoice[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(props.workspaceId);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceRetry, setWorkspaceRetry] = useState(0);

  useEffect(() => {
    setSelectedWorkspace(props.workspaceId);
  }, [props.workspaceId]);

  useEffect(() => {
    if (props.workspaceId) return;
    let cancelled = false;
    setWorkspaceError(null);
    void props.paseo.workspaces.list()
      .then(result => {
        if (cancelled) return;
        setChoices(result.entries.map(entry => ({ id: entry.id, label: entry.title || entry.name })));
      })
      .catch(error => {
        // A failed workspace list must not look like "no workspaces"; surface it with a retry.
        if (!cancelled) setWorkspaceError(parseDotBridgeError(error));
      });
    return () => { cancelled = true; };
  }, [props.paseo, props.workspaceId, workspaceRetry]);

  const tasks = useQuery(props.query.tasksOptionsFor(selectedWorkspace), props.query.client);
  const list = tasks.data?.tasks ?? [];
  const open = useMemo(() => list.find(task => task.id === openId) ?? null, [list, openId]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Pill colors={colors} active={tab === 'tasks'} onPress={() => setTab('tasks')} label="tasks">
          <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600' }}>{ui('Tasks', '任务')}</Text>
        </Pill>
        <Pill colors={colors} active={tab === 'connection'} onPress={() => setTab('connection')} label="connection">
          <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600' }}>{ui('Connection', '连接')}</Text>
        </Pill>
        <Pill colors={colors} active={tab === 'machines'} onPress={() => setTab('machines')} label="machines"><Text style={{ color: colors.foreground, fontSize: 12 }}>多机</Text></Pill>
      </View>

      {tab === 'tasks' && (open?.workspaceId ?? selectedWorkspace) ? <WorkspaceAuthorizationPanel key={open?.workspaceId ?? selectedWorkspace!} rpc={props.rpc} colors={colors} workspaceId={open?.workspaceId ?? selectedWorkspace!} /> : null}

      {tab === 'machines' ? <RemotePanel rpc={props.rpc} colors={colors} workspaceId={selectedWorkspace} /> : tab === 'connection' ? (
        <ConnectionCard theme={props.theme} host={props.host} layout={props.layout} rpc={props.rpc} query={props.query} />
      ) : open ? (
        <TaskDetail
          colors={colors}
          rpc={props.rpc}
          query={props.query}
          task={open}
          workspaceId={open.workspaceId}
          navigation={props.navigation}
          onBack={() => setOpenId(null)}
        />
      ) : (
        <View style={{ gap: 12 }}>
          {!props.workspaceId ? (
            <View style={{ gap: 6 }}>
              <SectionTitle colors={colors}>{ui('Workspace', '工作区')}</SectionTitle>
              {workspaceError ? (
                <View style={{ gap: 6 }}>
                  <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{workspaceError}</Text>
                  <Button label={ui('Retry', '重试')} colors={colors} variant="outline" size="sm" onPress={() => setWorkspaceRetry(value => value + 1)} />
                </View>
              ) : choices.length === 0 ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('No workspaces found.', '未找到工作区。')}</Text>
              ) : (
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {choices.map(choice => (
                    <Pill key={choice.id} colors={colors} active={selectedWorkspace === choice.id} onPress={() => setSelectedWorkspace(choice.id)} label={choice.label}>
                      <Text style={{ color: colors.foreground, fontSize: 12 }}>{choice.label}</Text>
                    </Pill>
                  ))}
                </View>
              )}
            </View>
          ) : null}

          {selectedWorkspace ? (
            <TaskEditor
              colors={colors}
              rpc={props.rpc}
              query={props.query}
              workspaceId={selectedWorkspace}
              onCreated={task => { setOpenId(task.id); void props.query.client.invalidateQueries({ queryKey: ['dot-bridge', 'tasks'] }); }}
            />
          ) : null}

          <View style={{ gap: 8 }}>
            <SectionTitle colors={colors}>{ui('Task history', '任务历史')}</SectionTitle>
            {tasks.isError ? (
              <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{parseDotBridgeError(tasks.error)}</Text>
            ) : tasks.data?.loadError ? (
              // A store that failed to load is not an empty list; say so and offer a retry.
              <View style={{ gap: 6 }}>
                <Text style={{ color: colors.statusDanger, fontSize: 12 }}>
                  {ui('The saved dot-bridge state could not be loaded.', '无法加载已保存的 dot-bridge 状态。')} {tasks.data.loadError}
                </Text>
                <Button label={ui('Retry', '重试')} colors={colors} variant="outline" size="sm" onPress={() => { void tasks.refetch(); }} />
              </View>
            ) : list.length === 0 ? (
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('No tasks yet.', '暂无任务。')}</Text>
            ) : (
              list.map(task => <TaskRow key={task.id} task={task} colors={colors} onOpen={() => setOpenId(task.id)} />)
            )}
          </View>
        </View>
      )}
    </ScrollView>
  );
}
