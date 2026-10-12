import { useState } from 'react';
import { Text, View } from 'react-native';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/react-native';
import type { Task } from '../shared/schema';
import { DOT_CONFIRMATION_URL, permissionCurrent } from '../shared/permissions';
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
  return <View style={{ gap: 8 }}>{permissions.map(p => {
    const current = permissionCurrent(task, p), pending = p.status === 'pending' && current;
    const title = p.platformBlock && current ? ui('Confirm in Your dot', '仍需在 Your dot 确认') : pending ? ui('Your confirmation is needed', '需要你确认') : ({ approved: ui('Allowed in Paseo', 'Paseo 已允许'), denied: ui('Denied', '已拒绝'), expired: ui('Request expired', '请求已失效'), pending: ui('Request expired', '请求已失效') }[p.status]);
    return <View key={p.requestId} style={{ borderWidth: 1, borderColor: pending || (p.platformBlock && current) ? colors.statusWarning : outline(colors), borderRadius: 8, padding: 12, gap: 8 }}>
      <Text style={{ color: colors.foreground, fontWeight: '700', fontSize: 14 }}>{title} · {p.title}</Text>
      <Text selectable style={{ color: colors.foreground, fontSize: 12 }}>{p.description}</Text>
      <Text selectable style={{ color: colors.foreground, fontSize: 12 }}>{p.scope.action}</Text>
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{p.scope.targets.map(path => `• ${path}`).join('\n')}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{ui('This choice covers only this request, not ChatGPT platform approval.', '仅确认本次请求的范围，不代表 ChatGPT 平台已批准。')}</Text>
      {pending ? <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button colors={colors} label={ui('Allow this operation', '允许本次操作')} disabled={busy !== null} onPress={() => { void decide(p.requestId, 'approved'); }} />
        <Button colors={colors} label={ui('Deny', '拒绝')} variant="outline" disabled={busy !== null} onPress={() => { void decide(p.requestId, 'denied'); }} />
      </View> : null}
      {p.platformBlock ? <>
        <Text selectable style={{ color: colors.statusWarning, fontSize: 12 }}>{p.platformBlock.reason}</Text>
        {current ? <>
          <Text style={{ color: colors.foreground, fontSize: 12 }}>{ui('Review the specific operation in Your dot, then return to this conversation.', '请在 Your dot 核对具体操作，完成确认后回到原会话告知 Dot。')}</Text>
          <Button colors={colors} label={ui('Open Your dot', '打开 Your dot')} variant="outline" onPress={() => props.open(DOT_CONFIRMATION_URL)} />
        </> : null}
      </> : null}
    </View>;
  })}</View>;
}
