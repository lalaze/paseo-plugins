import { useEffect, useState } from 'react';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { Text, View } from 'react-native';
import type { z } from 'zod';
import { workspaceAuthorizationGet, workspaceAuthorizationSet, workspaceAuthorizationStatusSchema } from '../shared/workspace-authorization';
import { Button, outline, type Colors } from './kit';
import { parseDotBridgeError } from './i18n';

type Status = z.infer<typeof workspaceAuthorizationStatusSchema>;
/** Mounted with key=workspaceId so a response from another workspace cannot change this control. */
export function WorkspaceAuthorizationPanel({ rpc, colors, workspaceId }: { rpc: PluginClientContext['rpc']; colors: Colors; workspaceId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [review, setReview] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    setStatus(null); setReview(false); setError('');
    void rpc(workspaceAuthorizationGet, { workspaceId }).then(value => { if (live) setStatus(value); })
      .catch(reason => { if (live) setError(parseDotBridgeError(reason)); });
    return () => { live = false; };
  }, [rpc, workspaceId, refresh]);
  async function save(enabled: boolean) {
    if (!status || busy) return;
    setBusy(true); setError('');
    try {
      const value = await rpc(workspaceAuthorizationSet, { workspaceId, workspaceRoot: status.workspaceRoot, rootIdentity: status.rootIdentity, enabled, revision: status.revision, confirm: true });
      setStatus(value); setReview(false);
    } catch (reason) { setStatus(null); setReview(false); setError(parseDotBridgeError(reason)); }
    finally { setBusy(false); }
  }
  return <View style={{ borderWidth: 1, borderColor: outline(colors), borderRadius: 10, padding: 12, gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>工作区自动授权 · {status ? status.enabled ? '已开启' : '未开启' : '读取中'}</Text>
      {status ? <Button colors={colors} size="xs" variant="outline" disabled={busy} label={status.enabled ? '关闭' : '开启'} onPress={() => status.enabled ? void save(false) : setReview(true)} /> : null}
    </View>
    {status?.enabled || review ? <>
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: 11 }}>{status?.workspaceRoot}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>允许 Dot 按任务要求读取、修改文件、传递附件和执行本机命令，无需逐次弹卡。命令以你的主机账户运行，可访问工作区外的文件和网络。</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 17 }}>仅此本地工作区，持续生效。已有待确认、拒绝和平台限制仍需处理；关闭后恢复原授权规则，已启动的命令继续运行。</Text>
    </> : null}
    {review ? <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
      <Button colors={colors} size="sm" disabled={busy} label="允许此工作区自动授权" onPress={() => void save(true)} />
      <Button colors={colors} size="sm" variant="ghost" disabled={busy} label="取消" onPress={() => setReview(false)} />
    </View> : null}
    {error ? <><Text style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text><Button colors={colors} size="xs" variant="outline" disabled={busy} label="重新读取" onPress={() => setRefresh(value => value + 1)} /></> : null}
  </View>;
}
