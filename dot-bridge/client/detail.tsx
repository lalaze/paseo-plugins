import { useState } from 'react';
import { AttachmentPanel } from './attachments';
import { PermissionPanel } from './permissions';
import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { copyText, Icon, useToast } from '@getpaseo/plugin/client/react-native';
import { Pressable, Text, TextInput, View } from 'react-native';
import { taskCancelRequest, taskHistory, taskMessageAdd, taskRoundCreate, taskRoundRetry } from '../shared/rpc';
import { canStartNextRound } from '../shared/machine';
import { currentRound, type Message, type Round, type RoundResult, type Task, type Verification } from '../shared/schema';
import { deliveryStatusLabel, isExplicitRejection, messageKindLabel, parseDotBridgeError, remoteStatusLabel, ui, verifyStatusLabel } from './i18n';
import { Button, outline, Pill, SectionTitle, tint, type Colors } from './kit';
import { usePendingOperation } from './operation';
import type { BridgeQuery } from './query';

export interface TaskDetailProps {
  colors: Colors;
  rpc: PluginClientContext['rpc'];
  query: BridgeQuery;
  task: Task;
  workspaceId: string;
  navigation?: PluginSurfaceProps['navigation'];
  onBack(): void;
}

const OCCUPYING = new Set(['dispatched', 'claimed', 'running', 'waiting_user']);
/** A very large diff is bounded here for rendering, and the client says so explicitly. */
const DIFF_RENDER_LIMIT = 40_000;

function authorLabel(message: Message): string {
  return message.author === 'user' ? ui('You', '你') : ui('Dot', 'dot');
}

/** The read marker is judged against the round the message belongs to, not the current round. */
function readSeq(task: Task, roundId: string): number {
  return task.rounds.find(round => round.roundId === roundId)?.processedThroughSeq ?? 0;
}

function retryableRound(round: Round): boolean {
  if (OCCUPYING.has(round.remoteStatus)) return false;
  return round.remoteStatus === 'failed'
    || round.remoteStatus === 'stopped'
    || (round.remoteStatus === 'completed' && round.result?.kind !== 'text' && round.verification.status !== 'verified');
}

interface ResultBlockProps {
  colors: Colors;
  result: RoundResult;
  verification: Verification;
  copy(text: string, label: string): void;
  openPr(url: string): void;
}

/** One delivered result together with the verification snapshot computed for that exact result. */
function ResultBlock(props: ResultBlockProps) {
  const { colors, result, verification } = props;
  if (result.kind === 'text') return (
    <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 8, padding: 10, gap: 8 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 20 }}>{result.summary}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Reported', '回报')}: {new Date(result.reportedAt).toLocaleString()}</Text>
      <Text style={{ color: result.coversLatest ? colors.foregroundMuted : colors.statusWarning, fontSize: 11 }}>
        {result.coversLatest ? ui('Covers your latest message.', '已覆盖你最新的一条消息。') : ui('Does not cover your latest message.', '尚未覆盖你最新的消息。')}
      </Text>
      <Button label={ui('Copy answer', '复制答复')} colors={colors} variant="outline" size="xs" onPress={() => props.copy(result.summary, ui('Answer', '答复'))} />
    </View>
  );
  return (
    <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 8, padding: 10, gap: 4 }}>
      <Text style={{ color: colors.foreground, fontSize: 13 }}>{result.summary || ui('(no summary)', '（无摘要）')}</Text>
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Base', '基准')} {result.baseSha}</Text>
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Head', 'head')} {result.headSha}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Reported', '回报')}: {new Date(result.reportedAt).toLocaleString()}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
        {ui('Verification', '验证')}: {verifyStatusLabel(verification.status)}
        {verification.at ? ` · ${new Date(verification.at).toLocaleString()}` : ''}
        {verification.verifiedHead ? ` · ${verification.verifiedHead.slice(0, 12)}` : ''}
      </Text>
      {verification.error ? <Text style={{ color: colors.statusDanger, fontSize: 11 }}>{verification.error}</Text> : null}
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
        {result.coversLatest
          ? ui('Covers your latest message.', '已覆盖你最新的一条消息。')
          : ui('Does NOT cover your latest message; the dot can still read the rest.', '尚未覆盖你最新的消息；dot 仍可继续读取。')}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        <Button label={ui('Copy branch', '复制分支')} colors={colors} variant="outline" size="xs" onPress={() => props.copy(result.branch, ui('Branch', '分支'))} />
        <Button label={ui('Copy head', '复制提交号')} colors={colors} variant="outline" size="xs" onPress={() => props.copy(result.headSha, ui('Commit', '提交'))} />
        {result.prUrl ? (
          <>
            <Button label={ui('Open PR', '打开 PR')} colors={colors} variant="outline" size="xs" onPress={() => props.openPr(result.prUrl!)} />
            <Button label={ui('Copy PR link', '复制 PR 链接')} colors={colors} variant="outline" size="xs" onPress={() => props.copy(result.prUrl!, 'PR')} />
          </>
        ) : null}
      </View>
      {verification.status === 'verified' ? (
        <>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, marginTop: 4 }}>{ui('Files', '文件')}: {verification.files.join(', ') || '—'}</Text>
          <Text style={{ color: colors.foreground, fontSize: 11, fontFamily: 'monospace', marginTop: 4 }}>
            {verification.patch.slice(0, DIFF_RENDER_LIMIT) || ui('(no diff)', '（无 diff）')}
          </Text>
          {verification.truncated ? (
            <Text style={{ color: colors.statusWarning, fontSize: 11 }}>{ui('The diff was truncated when it was stored.', 'diff 在保存时已被截断。')}</Text>
          ) : verification.patch.length > DIFF_RENDER_LIMIT ? (
            <Text style={{ color: colors.statusWarning, fontSize: 11 }}>
              {ui(`Showing the first ${DIFF_RENDER_LIMIT.toLocaleString()} characters of the diff.`, `仅显示 diff 的前 ${DIFF_RENDER_LIMIT.toLocaleString()} 个字符。`)}
            </Text>
          ) : null}
        </>
      ) : null}
      {result.checks.length ? (
        <View style={{ marginTop: 6, gap: 2 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Dot-reported checks (not run here)', 'dot 报告的检查（非本地执行）')}</Text>
          {result.checks.map((check, index) => (
            <Text key={index} style={{ color: check.passed === false ? colors.statusDanger : colors.foreground, fontSize: 11 }}>{check.command}: {check.result}</Text>
          ))}
        </View>
      ) : null}
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, marginTop: 4 }}>
        {ui('Git verification does not mean the tests passed.', 'Git 验证通过不代表测试通过。')}
      </Text>
    </View>
  );
}

export function TaskDetail(props: TaskDetailProps) {
  const { colors } = props;
  const toast = useToast();
  const task = props.task;
  const current = currentRound(task);
  const [selectedRoundId, setSelectedRoundId] = useState<string>(task.currentRoundId);
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<'requirement' | 'answer'>('requirement');
  const [busy, setBusy] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // The task-wide history query entry: results are never truncated, so a long history is paged here.
  const [fullHistory, setFullHistory] = useState<Array<{ roundId: string; result: RoundResult; verification: Verification; current: boolean }> | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  // One pending operation per action: a retry with the same intent reuses the id and the frozen
  // payload, so a lost response can never create a second round or a second Git refresh.
  const sendOp = usePendingOperation<{ id: string; revision: number; body: string; kind: 'requirement' | 'answer' }>();
  const cancelOp = usePendingOperation<{ id: string; revision: number }>();
  const roundOp = usePendingOperation<{ id: string; revision: number }>();
  const retryOp = usePendingOperation<{ id: string; revision: number }>();

  const selected = task.rounds.find(round => round.roundId === selectedRoundId) ?? current;
  const isCurrent = selected.roundId === task.currentRoundId;
  const localCancel = selected.remoteStatus === 'stopped' && selected.claim === null;

  async function refresh() {
    await props.query.client.invalidateQueries({ queryKey: ['dot-bridge', 'tasks'] });
    await props.query.client.invalidateQueries({ queryKey: ['dot-bridge', 'connection'] });
  }

  async function loadHistory(append: boolean) {
    setHistoryBusy(true);
    try {
      const page = await props.rpc(taskHistory, { id: task.id, cursor: append ? historyCursor : null });
      setFullHistory(prev => (append && prev ? [...prev, ...page.records] : page.records));
      setHistoryCursor(page.cursor);
    } catch (error) {
      toast.error(parseDotBridgeError(error));
    } finally {
      setHistoryBusy(false);
    }
  }

  async function send() {
    if (!draft.trim()) return;
    const body = draft.trim();
    setBusy('send');
    try {
      const pending = sendOp.begin(JSON.stringify({ id: task.id, body, kind }), { id: task.id, revision: task.revision, body, kind });
      await props.rpc(taskMessageAdd, { operationId: pending.operationId, ...pending.payload });
      sendOp.settle();
      setDraft('');
      await refresh();
    } catch (error) {
      // A conflict or failure keeps the draft so the user does not lose their text. An explicit
      // server decision releases the frozen request so the next Send uses a fresh id and the latest
      // revision; an uncertain failure keeps it, so a lost response cannot post the message twice.
      if (isExplicitRejection(error)) { sendOp.settle(); await refresh(); }
      toast.error(parseDotBridgeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function cancelOrStop() {
    setBusy('cancel');
    try {
      const pending = cancelOp.begin(JSON.stringify({ id: task.id }), { id: task.id, revision: task.revision });
      await props.rpc(taskCancelRequest, { operationId: pending.operationId, ...pending.payload });
      cancelOp.settle();
      toast.show(OCCUPYING.has(current.remoteStatus) ? ui('Stop requested', '已请求停止') : ui('Task canceled', '任务已取消'), { variant: 'info' });
      await refresh();
    } catch (error) {
      if (isExplicitRejection(error)) { cancelOp.settle(); await refresh(); }
      toast.error(parseDotBridgeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function nextRound() {
    setBusy('round');
    try {
      const pending = roundOp.begin(JSON.stringify({ id: task.id }), { id: task.id, revision: task.revision });
      await props.rpc(taskRoundCreate, { operationId: pending.operationId, ...pending.payload });
      roundOp.settle();
      toast.show(ui('Next round queued', '新一轮已排队'), { variant: 'success' });
      await refresh();
    } catch (error) {
      if (isExplicitRejection(error)) { roundOp.settle(); await refresh(); }
      toast.error(parseDotBridgeError(error));
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    setBusy('retry');
    try {
      const pending = retryOp.begin(JSON.stringify({ id: task.id }), { id: task.id, revision: task.revision });
      await props.rpc(taskRoundRetry, { operationId: pending.operationId, ...pending.payload });
      retryOp.settle();
      toast.show(ui('Round re-queued for the same task and base', '已按同一任务与基准重新排队'), { variant: 'info' });
      await refresh();
    } catch (error) {
      if (isExplicitRejection(error)) { retryOp.settle(); await refresh(); }
      toast.error(parseDotBridgeError(error));
    } finally {
      setBusy(null);
    }
  }

  function openPr(url: string) {
    const openBrowser = props.navigation?.openBrowser;
    if (openBrowser) openBrowser({ url, workspaceId: props.workspaceId });
    else void copy(url, 'PR');
  }

  async function copy(text: string, label: string) {
    try {
      await copyText(text);
      toast.show(ui(`${label} copied`, `${label} 已复制`), { variant: 'success' });
    } catch {
      toast.error(ui('Copy failed', '复制失败'));
    }
  }

  const canContinue = task.mode === 'text' && isCurrent && canStartNextRound(task);
  const canRetry = task.mode === 'text' && isCurrent && retryableRound(current);

  return (
    <View style={{ gap: 12 }}>
      <Pressable onPress={props.onBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name="ChevronLeft" size={16} color={colors.foregroundMuted} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{ui('All tasks', '全部任务')}</Text>
      </Pressable>

      <PermissionPanel task={task} roundId={selected.roundId} colors={colors} rpc={props.rpc} refresh={refresh} open={openPr} />

      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: '700' }}>{task.title}</Text>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Pill colors={colors}><Text style={{ color: colors.foreground, fontSize: 11 }}>{remoteStatusLabel(selected.remoteStatus, { localCancel })}</Text></Pill>
          {task.mode === 'git' ? <Pill colors={colors}><Text style={{ color: colors.foreground, fontSize: 11 }}>{verifyStatusLabel(selected.verification.status)}</Text></Pill> : null}
          <Pill colors={colors}><Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{task.mode === 'text' ? ui('Local workspace', '本地工作区') : ui('Historical Git task (read-only)', '旧 Git 记录（只读）')}</Text></Pill>
          {!isCurrent ? <Pill colors={colors}><Text style={{ color: colors.statusWarning, fontSize: 11 }}>{ui('older round', '旧轮次')}</Text></Pill> : null}
        </View>
        {task.rounds.length > 1 ? (
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            {task.rounds.map((round, index) => (
              <Pill key={round.roundId} colors={colors} active={round.roundId === selected.roundId} onPress={() => setSelectedRoundId(round.roundId)} label={`round-${index + 1}`}>
                <Text style={{ color: colors.foreground, fontSize: 11 }}>{ui('Round', '轮次')} {index + 1}</Text>
              </Pill>
            ))}
          </View>
        ) : null}
        {selected.stop.reported ? (
          <Text style={{ color: colors.statusWarning, fontSize: 12 }}>
            {ui('The dot reported this work stopped.', 'dot 已回报该工作已停止。')}{selected.stop.note ? ` ${selected.stop.note}` : ''}
          </Text>
        ) : selected.stop.requested ? (
          <Text style={{ color: colors.statusWarning, fontSize: 12 }}>
            {selected.remoteStatus === 'completed'
              ? ui('Stop was requested, but the dot completed the round anyway.', '已请求停止，但 dot 仍完成了本轮。')
              : localCancel
                ? ui('Canceled locally before Dot claimed it.', 'Dot 领取前已在本地取消。')
                : ui('Stop requested — waiting for the dot to report.', '已请求停止 —— 等待 dot 回报。')}
          </Text>
        ) : null}
        {selected.dispatchBlocked ? (
          <Text style={{ color: colors.statusWarning, fontSize: 12 }}>
            {selected.dispatchBlocked.reason === 'base-unreachable'
              ? ui('Waiting: the base commit is not reachable from the remote right now. The bridge retries automatically.', '等待中：当前无法从远端取得基准提交。桥接会自动重试。')
              : `${ui('Waiting', '等待中')}: ${selected.dispatchBlocked.reason}`}
          </Text>
        ) : null}
        {selected.verification.error ? (
          <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{ui('Verification', '验证')}: {selected.verification.error}</Text>
        ) : null}
      </View>

      <View style={{ gap: 8 }}>
        <SectionTitle colors={colors}>{ui('Conversation', '对话')}</SectionTitle>
        {task.messages.map(message => (
          <View key={message.seq} style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 8, padding: 10, gap: 3 }}>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
              <Text style={{ color: message.author === 'user' ? colors.accent : colors.foreground, fontSize: 12, fontWeight: '600' }}>{authorLabel(message)}</Text>
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{messageKindLabel(message.kind)}</Text>
              <Text style={{ color: tint(colors.foregroundMuted, 0.7), fontSize: 11 }}>#{message.seq}</Text>
              {message.author === 'user' ? (
                <Text style={{ color: message.delivery === 'failed' ? colors.statusDanger : colors.foregroundMuted, fontSize: 11 }}>
                  {message.seq <= readSeq(task, message.roundId) ? ui('Read by dot', 'dot 已读取') : deliveryStatusLabel(message.delivery)}
                </Text>
              ) : null}
            </View>
            <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{message.body}</Text>
            {message.author === 'user' && message.delivery === 'failed' && message.deliveryError ? (
              <Text style={{ color: colors.statusDanger, fontSize: 11 }}>{message.deliveryError}</Text>
            ) : null}
          </View>
        ))}
      </View>

      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {(['requirement', 'answer'] as const).map(value => (
            <Pill key={value} colors={colors} active={kind === value} onPress={() => setKind(value)} label={value}>
              <Text style={{ color: colors.foreground, fontSize: 11 }}>{value === 'requirement' ? ui('Add requirement', '追加需求') : ui('Answer', '回复问题')}</Text>
            </Pill>
          ))}
        </View>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={kind === 'requirement' ? ui('Follow-up requirement', '追加要求') : ui('Answer the dot', '回复 dot')}
          placeholderTextColor={tint(colors.foregroundMuted, 0.7)}
          multiline
          style={{ color: colors.foreground, borderWidth: 1, borderColor: outline(colors), borderRadius: 8, padding: 10, minHeight: 60, textAlignVertical: 'top', fontSize: 13 }}
        />
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Button label={ui('Send', '发送')} colors={colors} onPress={send} disabled={task.mode === 'git' || busy !== null || !draft.trim()} />
          {OCCUPYING.has(current.remoteStatus) ? (
            <Button label={ui('Request stop', '请求停止')} colors={colors} variant="danger" onPress={cancelOrStop} disabled={busy !== null || current.stop.requested} />
          ) : current.remoteStatus === 'queued' ? (
            <Button label={ui('Cancel', '取消')} colors={colors} variant="outline" onPress={cancelOrStop} disabled={busy !== null} />
          ) : null}
          {canRetry ? <Button label={ui('Retry this round', '重试本轮')} colors={colors} variant="outline" onPress={retry} disabled={busy !== null} /> : null}
          {canContinue ? <Button label={ui('New round', '新一轮')} colors={colors} variant="outline" onPress={nextRound} disabled={busy !== null} /> : null}
        </View>
      </View>

      {selected.result ? (
        <View style={{ gap: 6 }}>
          <SectionTitle colors={colors}>{ui('Result', '成果')}</SectionTitle>
          <ResultBlock colors={colors} result={selected.result} verification={selected.verification} copy={copy} openPr={openPr} />
          {selected.resultHistory.length > 0 ? (
            <View style={{ gap: 6 }}>
              <Button
                label={showHistory ? ui('Hide earlier results', '隐藏更早的成果') : ui(`Show ${selected.resultHistory.length} earlier result(s)`, `显示更早的 ${selected.resultHistory.length} 个成果`)}
                colors={colors}
                variant="ghost"
                size="sm"
                onPress={() => setShowHistory(value => !value)}
              />
              {showHistory
                ? [...selected.resultHistory].reverse().map(record => (
                    <View key={record.result.updateId} style={{ gap: 4 }}>
                      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('Earlier result', '更早的成果')} · {record.result.updateId}</Text>
                      <ResultBlock colors={colors} result={record.result} verification={record.verification} copy={copy} openPr={openPr} />
                    </View>
                  ))
                : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {task.localChanges.length ? <View style={{gap: 6}}>
        <SectionTitle colors={colors}>{ui('Local file changes', '本地文件变更')}</SectionTitle>
        {task.localChanges.map(change => <View key={change.operationId} style={{gap: 3}}>
          <Text style={{color: change.status === 'applied' ? colors.foreground : colors.statusWarning, fontSize: 12}}>{change.status === 'applied' ? ui('Applied', '已应用') : change.status === 'partial' ? ui('Partially applied', '部分应用') : ui('Conflict — not applied', '冲突，未应用')}</Text>
          {change.files.map(file => <Text key={file.path} selectable style={{color: colors.foregroundMuted, fontSize: 12}}>{file.action}: {file.path}</Text>)}
          {change.conflicts.map((note, index) => <Text key={index} style={{color: colors.statusWarning, fontSize: 12}}>{note}</Text>)}
        </View>)}
      </View> : null}

      <AttachmentPanel readOnly={task.mode === 'git'} key={task.id} colors={colors} rpc={props.rpc} task={task} refresh={refresh} />

      <View style={{ gap: 6 }}>
        <SectionTitle colors={colors}>{ui('Full history', '完整历史')}</SectionTitle>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
          {ui(
            'Every delivered result across all rounds. Nothing is silently dropped; use Load more to page through it.',
            '所有轮次已交付的成果。不会静默丢弃；可用「加载更多」分页查看。',
          )}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <Button label={ui('Load history', '加载历史')} colors={colors} variant="outline" size="sm" onPress={() => void loadHistory(false)} disabled={historyBusy} />
          {fullHistory && historyCursor !== null ? (
            <Button label={ui('Load more', '加载更多')} colors={colors} variant="ghost" size="sm" onPress={() => void loadHistory(true)} disabled={historyBusy} />
          ) : null}
        </View>
        {fullHistory ? (
          fullHistory.length === 0 ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('No results yet.', '暂无成果。')}</Text>
          ) : (
            fullHistory.map(record => (
              <View key={`${record.roundId}:${record.result.updateId}`} style={{ gap: 4 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                  {record.current ? ui('current round', '当前轮次') : ui('older round', '旧轮次')} · {record.result.updateId}
                </Text>
                <ResultBlock colors={colors} result={record.result} verification={record.verification} copy={copy} openPr={openPr} />
              </View>
            ))
          )
        ) : null}
      </View>
    </View>
  );
}
