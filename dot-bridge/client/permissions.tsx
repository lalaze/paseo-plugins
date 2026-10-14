import { useState } from 'react';
import { Text, View } from 'react-native';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/react-native';
import type { Task } from '../shared/schema';
import { DOT_CONFIRMATION_URL, permissionCurrent, permissionDescription, permissionState, permissionSummary, permissionCommand } from '../shared/permissions';
import { taskPermissionRespond } from '../shared/rpc';
import { Button, MONO, outline, tint, type Colors } from './kit';
import { parseDotBridgeError, ui } from './i18n';

export function PermissionPanel(props: { task: Task; roundId: string; colors: Colors; rpc: PluginClientContext['rpc']; refresh(): Promise<void>; open(url: string): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toast = useToast(), { task, colors } = props;
  const permissions = task.permissions.filter(p => p.roundId === props.roundId);
  async function decide(requestId: string, decision: 'approved' | 'denied') {
    setBusy(requestId);
    try {
      await props.rpc(taskPermissionRespond, { taskId: task.id, requestId, decision });
      await props.refresh();
    } catch (error) {
      toast.error(parseDotBridgeError(error));
      await props.refresh();
    } finally { setBusy(null); }
  }
  return <View style={{ gap: 8 }}>
    {permissions.map(p => {
    const current = permissionCurrent(task, p), pending = p.status === 'pending' && !p.platformBlock && current;
    const state = permissionState(task, p);
    const title = ({ pending: ui('Your confirmation is needed', '等待 Paseo 确认'), approved: ui('Allowed in Paseo', 'Paseo 已允许 · 当前有效'), denied: ui('Denied; explicit approval required', '已拒绝 · 需明确重新授权'), expired: ui('Request expired', '授权已失效'), consumed: ui('Operation authorization used', '本次操作授权已使用'), 'platform-blocked': ui('Blocked by ChatGPT', 'ChatGPT 平台仍阻塞'), superseded: ui('Replaced by a newer request', '历史请求 · 已由新请求替代') })[state];
    const command = permissionCommand(p), detailsOpen = expanded.has(p.requestId);
    return <View key={p.requestId} style={{ borderWidth: 1, borderColor: pending || (p.platformBlock && current) ? tint(colors.statusWarning, 0.5) : outline(colors), borderRadius: 12, padding: 14, gap: 10 }}>
      <Text style={{ color: pending ? colors.statusWarning : colors.foregroundMuted, fontSize: 11 }}>{title}</Text>
      <Text style={{ color: colors.foreground, fontWeight: '700', fontSize: 14 }}>{p.title}</Text>
      {command ? <View style={{ backgroundColor: colors.surface2, borderRadius: 8, padding: 10 }}><Text selectable style={{ color: colors.foreground, fontFamily: MONO, fontSize: 12, lineHeight: 18 }}>{command}</Text></View> : null}
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{permissionSummary(p, task.workspaceRoot)}</Text>
      {state === 'denied' || state === 'expired' ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('A normal follow-up does not restore guarded access. Ask Dot to submit a new scoped request if you want to authorize it.', '普通追问不会恢复受限访问。如需授权，请让 Dot 提交新的明确范围请求。')}</Text> : null}
      {pending ? <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button colors={colors} label={p.scope.operation ? ui('Allow once', '允许一次') : /^(read_dot_|list_dot_files)/.test(p.scope.toolName) ? ui('Allow scoped reads', '允许范围读取') : ui('Confirm', '确认')} disabled={busy !== null} onPress={() => { void decide(p.requestId, 'approved'); }} />
        <Button colors={colors} label={ui('Deny', '拒绝')} variant="outline" disabled={busy !== null} onPress={() => { void decide(p.requestId, 'denied'); }} />
      </View> : null}
      <Button colors={colors} label={detailsOpen ? ui('Hide details', '收起详情') : ui('Show details', '查看详情')} variant="ghost" size="xs" onPress={() => setExpanded(previous => { const next = new Set(previous); if (next.has(p.requestId)) next.delete(p.requestId); else next.add(p.requestId); return next; })} />
      {detailsOpen ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{permissionDescription(p)}</Text> : null}
      {p.platformBlock ? <>
        <Text selectable style={{ color: colors.statusWarning, fontSize: 12 }}>{p.platformBlock.reason}</Text>
        {current ? <>
          <Text style={{ color: colors.foreground, fontSize: 12 }}>{ui('Check the actual refusal and available next steps in Your dot, then return here. Local approval cannot clear platform restrictions.', '请在 Your dot 查看实际拒绝原因和可用的处理方式，再回到本会话。本地允许不能解除平台限制，也不保证平台提供确认入口。')}</Text>
          <Button colors={colors} label={ui('Open Your dot', '打开 Your dot')} variant="outline" onPress={() => props.open(DOT_CONFIRMATION_URL)} />
        </> : null}
      </> : null}
    </View>;
  })}</View>;
}
