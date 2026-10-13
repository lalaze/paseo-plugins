import { useState } from 'react';
import { Text, View } from 'react-native';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/react-native';
import type { Task } from '../shared/schema';
import { DOT_CONFIRMATION_URL, permissionCurrent, permissionDescription, permissionState } from '../shared/permissions';
import { taskPermissionRespond } from '../shared/rpc';
import { Button, outline, type Colors } from './kit';
import { parseDotBridgeError, ui } from './i18n';

export function PermissionPanel(props: { task: Task; roundId: string; colors: Colors; rpc: PluginClientContext['rpc']; refresh(): Promise<void>; open(url: string): void }) {
  const [busy, setBusy] = useState<string | null>(null);
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
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{ui('Task access follows your request. Additional Paseo confirmations are scoped below. ChatGPT platform approval is separate and is reported by Dot.', '任务访问以你的请求为范围；额外的 Paseo 确认列在下方。ChatGPT 平台审批独立处理，其阻塞状态由 Dot 回报。')}</Text>
    {permissions.map(p => {
    const current = permissionCurrent(task, p), pending = p.status === 'pending' && !p.platformBlock && current;
    const state = permissionState(task, p);
    const title = ({ pending: ui('Your confirmation is needed', '等待 Paseo 确认'), approved: ui('Allowed in Paseo', 'Paseo 已允许 · 当前有效'), denied: ui('Denied; explicit approval required', '已拒绝 · 需明确重新授权'), expired: ui('Request expired', '授权已失效'), consumed: ui('Operation authorization used', '本次操作授权已使用'), 'platform-blocked': ui('Blocked by ChatGPT', 'ChatGPT 平台仍阻塞'), superseded: ui('Replaced by a newer request', '历史请求 · 已由新请求替代') })[state];
    return <View key={p.requestId} style={{ borderWidth: 1, borderColor: pending || (p.platformBlock && current) ? colors.statusWarning : outline(colors), borderRadius: 8, padding: 12, gap: 8 }}>
      <Text style={{ color: colors.foreground, fontWeight: '700', fontSize: 14 }}>{title} · {p.title}</Text>
      <Text selectable style={{ color: colors.foreground, fontSize: 12 }}>{permissionDescription(p)}</Text>
      {state === 'denied' || state === 'expired' ? <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('A normal follow-up does not restore guarded access. Ask Dot to submit a new scoped request if you want to authorize it.', '普通追问不会恢复受限访问。如需授权，请让 Dot 提交新的明确范围请求。')}</Text> : null}
      {pending ? <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button colors={colors} label={p.scope.operation ? ui('Allow this operation once', '允许本次操作一次') : /^(read_dot_|list_dot_files)/.test(p.scope.toolName) ? ui('Allow scoped reads', '允许上述范围读取') : ui('Confirm this request', '确认本次请求')} disabled={busy !== null} onPress={() => { void decide(p.requestId, 'approved'); }} />
        <Button colors={colors} label={ui('Deny', '拒绝')} variant="outline" disabled={busy !== null} onPress={() => { void decide(p.requestId, 'denied'); }} />
      </View> : null}
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
