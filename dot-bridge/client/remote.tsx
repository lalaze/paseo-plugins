import { useEffect, useState } from 'react';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { Text, TextInput, View } from 'react-native';
import { z } from 'zod';
import { remoteState, remoteStateSchema, remoteConfigure, remoteCreateDevice, remoteRevokeDevice, type RemoteConfig } from '../shared/remote';
import { Button, Pill, type Colors } from './kit';

type State = z.infer<typeof remoteStateSchema>;
export function RemotePanel({ rpc, colors, workspaceId }: { rpc: PluginClientContext['rpc']; colors: Colors; workspaceId: string | null }) {
  const [state, setState] = useState<State | null>(null), [draft, setDraft] = useState<RemoteConfig | null>(null);
  const [token, setToken] = useState(''), [name, setName] = useState(''), [workspaces, setWorkspaces] = useState(workspaceId ?? '');
  const [read, setRead] = useState(false), [write, setWrite] = useState(false), [issued, setIssued] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<{ text: string; run(): Promise<void> } | null>(null);
  async function refresh() { const value = await rpc(remoteState, {}); setState(value); setDraft(value.config); }
  useEffect(() => { let live = true; void rpc(remoteState, {}).then(value => { if (live) { setState(value); setDraft(value.config); } }).catch(() => { if (live) setError('无法读取多机设置'); }); return () => { live = false; }; }, [rpc]);
  async function perform(run: () => Promise<void>) {
    setBusy(true); setError(''); setPending(null);
    try { await run(); } catch { setError('操作失败或结果尚未确认。请先刷新核对状态，不要重复创建设备。'); } finally { setBusy(false); }
  }
  const textStyle = { color: colors.foreground, fontSize: 13 };
  const fieldStyle = { color: colors.foreground, borderWidth: 1, borderColor: colors.foregroundMuted, borderRadius: 6, padding: 8 };
  if (!state || !draft) return <View><Text style={textStyle}>{error || '读取多机设置中…'}</Text><Button colors={colors} label="刷新" onPress={() => void perform(refresh)} /></View>;
  const ids = (value: string) => [...new Set(value.split(/[\s,，]+/).filter(Boolean))];
  return <View style={{ gap: 10 }}>
    <Text style={textStyle}>当前模式：{state.config.mode} · {state.connected ? '已连接' : '未连接'}</Text>
    <Text style={textStyle}>{state.endpoint || state.config.url}</Text>
    {state.error ? <Text style={{ color: colors.statusDanger }}>{state.error}</Text> : null}
    <Text style={textStyle}>中心保留 ChatGPT 连接；远端主动连接中心，文件只在发起机器的绑定工作区执行。默认不启用共享。切换模式用于新会话。</Text>
    <View style={{ flexDirection: 'row', gap: 6 }}>{(['local','center','remote'] as const).map(mode => <Pill key={mode} colors={colors} active={draft.mode === mode} onPress={() => setDraft({ ...draft, mode })}><Text style={textStyle}>{mode}</Text></Pill>)}</View>
    {draft.mode === 'center' ? <>
      <Text style={textStyle}>监听地址与端口（HTTPS 由你配置的可信反向代理提供）</Text>
      <TextInput style={fieldStyle} value={draft.host} onChangeText={host => setDraft({ ...draft, host })} />
      <TextInput style={fieldStyle} value={String(draft.port)} keyboardType="numeric" onChangeText={value => setDraft({ ...draft, port: Number(value) })} />
    </> : draft.mode === 'remote' ? <>
      <Text style={textStyle}>中心 HTTPS 地址</Text>
      <TextInput style={fieldStyle} autoCapitalize="none" value={draft.url} onChangeText={url => setDraft({ ...draft, url })} />
      <Text style={textStyle}>设备凭证（仅在此机器输入并保存；留空保留已配置凭证）</Text>
      <TextInput style={fieldStyle} secureTextEntry autoCapitalize="none" value={token} onChangeText={setToken} />
      <Text style={textStyle}>允许的本机工作区 ID，用逗号分隔。当前工作区：{workspaceId ?? '请从工作区面板确认'}</Text>
      <TextInput style={fieldStyle} value={draft.workspaceIds.join(', ')} onChangeText={value => setDraft({ ...draft, workspaceIds: ids(value) })} />
      <Button colors={colors} label={'受信私网 HTTP：' + (draft.privateHttp ? '允许' : '禁止')} onPress={() => setDraft({ ...draft, privateHttp: !draft.privateHttp })} />
      <Button colors={colors} label={'本机文件读取：' + (draft.readFiles ? '允许' : '禁止')} onPress={() => setDraft({ ...draft, readFiles: !draft.readFiles, writeFiles: draft.readFiles ? false : draft.writeFiles })} />
      <Button colors={colors} label={'本机文件修改：' + (draft.writeFiles ? '允许' : '禁止')} onPress={() => setDraft({ ...draft, writeFiles: !draft.writeFiles, readFiles: !draft.writeFiles ? true : draft.readFiles })} />
    </> : null}
    <Button colors={colors} disabled={busy} label="检查并保存设置" onPress={() => {
      const config = structuredClone(draft), credential = token || undefined;
      setPending({ text: '确认切换为 ' + config.mode + '。' + (config.mode === 'center' ? '将在 ' + config.host + ':' + config.port + ' 打开设备网关监听。' : config.mode === 'remote' ? '将保存设备凭证并持续连接 ' + config.url + '，共享所选工作区的任务文字、附件，以及已允许的文件读取／修改能力。' : '将停止多机连接。') + ' 文件修改：' + (config.writeFiles ? '允许' : '禁止') + '。', run: async () => { const value = await rpc(remoteConfigure, { config, ...(credential ? { token: credential } : {}), confirm: true }); setState(value); setDraft(value.config); setToken(''); } });
    }} />
    {state.config.mode === 'center' ? <>
      <Text style={textStyle}>创建设备。工作区 ID 填远端机器上的 ID，授权仅覆盖这些工作区。聊天和附件将允许。</Text>
      <TextInput style={fieldStyle} placeholder="设备名称" value={name} onChangeText={setName} />
      <TextInput style={fieldStyle} placeholder="远端工作区 ID" value={workspaces} onChangeText={setWorkspaces} />
      <Button colors={colors} label={'授权文件读取：' + (read ? '允许' : '禁止')} onPress={() => { setRead(!read); if (read) setWrite(false); }} />
      <Button colors={colors} label={'授权文件修改：' + (write ? '允许' : '禁止')} onPress={() => { setWrite(!write); if (!write) setRead(true); }} />
      <Button colors={colors} disabled={busy || !name.trim() || !ids(workspaces).length} label="检查并创建设备" onPress={() => {
        const input = { name: name.trim(), workspaceIds: ids(workspaces), capabilities: { chat: true, attachments: true, readFiles: read, writeFiles: write }, confirm: true as const };
        setPending({ text: '为 ' + input.name + ' 创建持续访问凭证。工作区：' + input.workspaceIds.join(', ') + '；聊天、附件：允许；读取：' + read + '；修改：' + write + '。凭证只显示这一次，请只交给自己的目标设备。', run: async () => { const result = await rpc(remoteCreateDevice, input); setIssued(result.token); await refresh(); } });
      }} />
      {issued ? <View style={{ gap: 6 }}><Text style={textStyle}>新设备凭证，只显示本次：</Text><Text selectable style={textStyle}>{issued}</Text><Button colors={colors} label="隐藏凭证" onPress={() => setIssued('')} /></View> : null}
      {state.devices.map(device => <View key={device.id} style={{ gap: 4 }}><Text style={textStyle}>{device.name} · {device.revoked ? '已撤销' : '有效'} · {device.workspaceIds.join(', ')} · 读取 {String(device.capabilities.readFiles)} / 修改 {String(device.capabilities.writeFiles)}</Text>{!device.revoked ? <Button colors={colors} disabled={busy} label="撤销此设备" onPress={() => setPending({ text: '确认撤销 ' + device.name + ' 的持续访问？正在执行的文件操作结果仍需核对。', run: async () => { setState(await rpc(remoteRevokeDevice, { id: device.id, confirm: true })); } })} /> : null}</View>)}
    </> : null}
    {pending ? <View style={{ gap: 8 }}><Text style={textStyle}>{pending.text}</Text><Button colors={colors} disabled={busy} label="确认执行" onPress={() => void perform(pending.run)} /><Button colors={colors} label="取消" onPress={() => setPending(null)} /></View> : null}
    {error ? <Text style={{ color: colors.statusDanger }}>{error}</Text> : null}
    <Button colors={colors} disabled={busy} label="刷新状态" onPress={() => void perform(refresh)} />
  </View>;
}
