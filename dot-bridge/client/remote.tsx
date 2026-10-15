import { useEffect, useState, type ReactNode } from 'react';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { copyText, Icon } from '@getpaseo/plugin/client/react-native';
import { Pressable, Switch, Text, TextInput, View, type TextInputProps } from 'react-native';
import { z } from 'zod';
import { remoteState, remoteStateSchema, remoteConfigure, remoteCreateDevice, remoteRevokeDevice, type RemoteConfig } from '../shared/remote';
import { isTailscaleIp, isTailscaleOrigin } from '../shared/tailscale';
import { ui } from './i18n';
import { Button, cardFill, controlFill, MONO, outline, tint, type Colors } from './kit';

type State = z.infer<typeof remoteStateSchema>;
type Pending = { kind: 'config' | 'create' | 'revoke'; text: string; run(): Promise<void> };
const ids = (value: string) => [...new Set(value.split(/[\s,，]+/).filter(Boolean))];
const modeLabel = (mode: RemoteConfig['mode']) => ({ local: ui('This device', '仅本机'), center: ui('Center', '中心机器'), remote: ui('Remote', '远端机器') })[mode];
const allowed = (value: boolean) => value ? ui('allowed', '允许') : ui('denied', '禁止');

function Section({ title, description, colors, children }: { title: string; description: string; colors: Colors; children: ReactNode }) {
  return <View style={{ gap: 16, padding: 18, borderRadius: 12, borderWidth: 1, borderColor: outline(colors), backgroundColor: cardFill(colors), minWidth: 0 }}>
    <View style={{ gap: 5 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '600' }}>{title}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 19 }}>{description}</Text>
    </View>{children}
  </View>;
}
function Field({ label, hint, colors, ...input }: TextInputProps & { label: string; hint?: string; colors: Colors }) {
  return <View style={{ gap: 7, minWidth: 0 }}>
    <Text style={{ color: colors.foreground, fontSize: 12 }}>{label}</Text>
    <TextInput {...input} accessibilityLabel={label} autoCapitalize="none" autoCorrect={false} placeholderTextColor={tint(colors.foregroundMuted, 0.65)} style={{ color: colors.foreground, backgroundColor: controlFill(colors), borderWidth: 1, borderColor: outline(colors), borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, minWidth: 0 }} />
    {hint ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 17 }}>{hint}</Text> : null}
  </View>;
}
function Toggle({ label, detail, value, onChange, colors, disabled }: { label: string; detail: string; value: boolean; onChange(value: boolean): void; colors: Colors; disabled: boolean }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 44 }}>
    <View style={{ flex: 1, gap: 4 }}><Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text><Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 17 }}>{detail}</Text></View>
    <Switch accessibilityLabel={label} value={value} onValueChange={onChange} disabled={disabled} trackColor={{ false: colors.surface2, true: colors.statusSuccess ?? colors.foreground }} />
  </View>;
}

export function RemotePanel({ rpc, colors, workspaceId, compact = false }: { rpc: PluginClientContext['rpc']; colors: Colors; workspaceId: string | null; compact?: boolean }) {
  const [state, setState] = useState<State | null>(null), [draft, setDraft] = useState<RemoteConfig | null>(null);
  const [token, setToken] = useState(''), [name, setName] = useState(''), [workspaces, setWorkspaces] = useState('');
  const [read, setRead] = useState(false), [write, setWrite] = useState(false), [issued, setIssued] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  async function refresh(resetDraft = false) {
    const value = await rpc(remoteState, {}); setState(value);
    if (resetDraft) setDraft(value.config);
  }
  useEffect(() => {
    let live = true;
    void rpc(remoteState, {}).then(value => { if (live) { setState(value); setDraft(value.config); } }).catch(() => { if (live) setError(ui('Could not load machine settings.', '无法读取多机设置。')); });
    return () => { live = false; };
  }, [rpc]);
  // Editing a form invalidates confirmation of its previous settings.
  useEffect(() => { setPending(null); }, [draft, token, name, workspaces, read, write]);
  async function perform(run: () => Promise<void>) {
    setBusy(true); setError(''); setPending(null);
    try { await run(); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : ui('The result could not be confirmed. Refresh before creating another device.', '操作失败或结果尚未确认。请先刷新核对状态，不要重复创建设备。')); }
    finally { setBusy(false); }
  }
  const muted = { color: colors.foregroundMuted, fontSize: 12, lineHeight: 19 };
  const body = { color: colors.foreground, fontSize: 13, lineHeight: 20 };
  if (!state || !draft) return <View style={{ gap: 12 }}><Text style={muted}>{error || ui('Loading machine settings…', '正在读取多机设置…')}</Text><Button colors={colors} variant="outline" disabled={busy} label={ui('Retry', '重新加载')} onPress={() => void perform(() => refresh(true))} /></View>;
  const config = draft;
  const modes = [
    { mode: 'local' as const, icon: 'Monitor', detail: ui('Work on this device only.', '只使用这台机器的工作区') },
    { mode: 'center' as const, icon: 'Network', detail: ui('Keep Dot connected. Add devices.', '保留 Dot 连接，接入其他机器') },
    { mode: 'remote' as const, icon: 'Laptop', detail: ui('Use the center’s Dot locally.', '借用中心的 Dot，处理本机工作区') },
  ];
  const status = state.connected
    ? state.config.mode === 'center' ? ui('Gateway running', '网关已启动') : state.config.mode === 'local' ? ui('Dot ready', 'Dot 已就绪') : ui('Connected to center', '已连接中心')
    : state.config.mode === 'center' ? ui('Gateway stopped', '网关未启动') : state.config.mode === 'local' ? ui('Dot not ready', 'Dot 未就绪') : ui('Not connected', '未连接中心');
  const statusColor = state.connected ? colors.statusSuccess ?? colors.foreground : colors.foregroundMuted;
  const confirmation = (kind: Pending['kind']) => pending?.kind === kind ? <View style={{ gap: 12, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: outline(colors), backgroundColor: controlFill(colors) }}>
    <Text style={{ ...body, fontWeight: '600' }}>{ui('Review changes', '确认变更')}</Text><Text style={muted}>{pending.text}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Button colors={colors} disabled={busy} variant={kind === 'revoke' ? 'danger' : 'primary'} label={ui('Confirm', '确认执行')} onPress={() => void perform(pending.run)} />
      <Button colors={colors} disabled={busy} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setPending(null)} />
    </View>
  </View> : null;
  const permissions = (local: boolean) => <View style={{ gap: 12 }}>
    <Toggle colors={colors} disabled={busy} label={ui('Read files', '读取文件')} detail={ui('List and read selected workspace files.', '列出和读取所选工作区中的文件')} value={local ? config.readFiles : read} onChange={value => {
      if (local) setDraft({ ...config, readFiles: value, writeFiles: value ? config.writeFiles : false });
      else { setRead(value); if (!value) setWrite(false); }
    }} />
    <View style={{ height: 1, backgroundColor: outline(colors) }} />
    <Toggle colors={colors} disabled={busy} label={ui('Edit files', '修改文件')} detail={ui('Create, update and delete files. Includes reading.', '创建、更新和删除文件，同时开启读取权限')} value={local ? config.writeFiles : write} onChange={value => {
      if (local) setDraft({ ...config, writeFiles: value, readFiles: value || config.readFiles });
      else { setWrite(value); if (value) setRead(true); }
    }} />
  </View>;
  return <View style={{ gap: 20 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
      <View style={{ flex: 1, minWidth: 180, gap: 6 }}>
        <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: '600' }}>{ui('One Dot, multiple machines', '一个 Dot，多台机器')}</Text>
        <Text style={muted}>{ui('Keep ChatGPT on the center. Work in each device’s own workspace.', 'ChatGPT 连接留在中心，任务和文件操作回到各自机器。')}</Text>
      </View>
      <Button colors={colors} variant="ghost" icon="RefreshCw" disabled={busy} label={ui('Refresh', '刷新状态')} onPress={() => void perform(() => refresh())} />
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: tint(statusColor, 0.1), borderRadius: 6 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor }} /><Text style={{ color: statusColor, fontSize: 11 }}>{modeLabel(state.config.mode)} · {status}</Text>
      </View>
      {state.endpoint || state.config.url ? <Text selectable style={{ ...muted, fontFamily: MONO, fontSize: 11, flexShrink: 1 }}>{state.endpoint || state.config.url}</Text> : null}
    </View>
    {state.error || error ? <View accessibilityRole="alert" style={{ padding: 12, borderRadius: 8, backgroundColor: tint(colors.statusDanger, 0.1) }}><Text style={{ ...muted, color: colors.statusDanger }}>{error || state.error}</Text></View> : null}
    <View style={{ flexDirection: 'row', flexWrap: compact ? 'nowrap' : 'wrap', gap: 8 }}>
      {modes.map(item => {
        const active = config.mode === item.mode;
        return <Pressable key={item.mode} accessibilityRole="radio" accessibilityLabel={modeLabel(item.mode)} accessibilityState={{ checked: active, disabled: busy }} disabled={busy} onPress={() => setDraft({ ...config, mode: item.mode, transport: 'tailscale', ...(item.mode === 'center' && state.tailscaleAddress ? { host: state.tailscaleAddress } : {}) })} style={({ pressed }) => ({ flex: 1, minWidth: compact ? 0 : 150, gap: 10, padding: compact ? 10 : 14, borderWidth: 1, borderColor: active ? tint(colors.foreground, 0.5) : outline(colors), borderRadius: 10, backgroundColor: active || pressed ? controlFill(colors) : 'transparent' })}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{compact ? null : <Icon name={item.icon} size={16} color={active ? colors.foreground : colors.foregroundMuted} />}<Text style={{ ...body, fontSize: compact ? 12 : 13, flex: 1, fontWeight: '600' }}>{modeLabel(item.mode)}</Text>{active ? <Icon name="Check" size={14} color={colors.foreground} /> : null}</View>
          {compact ? null : <Text style={{ ...muted, fontSize: 11 }}>{item.detail}</Text>}
        </Pressable>;
      })}
    </View>
    <Section colors={colors} title={config.mode === 'center' ? ui('Center gateway', '中心网关') : config.mode === 'remote' ? ui('Connect to center', '连接中心机器') : ui('Local mode', '仅在本机使用')} description={config.mode === 'center' ? ui('Other devices connect here. The ChatGPT MCP connection stays here.', '其他机器通过这个网关接入。ChatGPT 的 MCP 连接继续保留在这台机器。') : config.mode === 'remote' ? config.transport === 'tailscale' ? ui('Enter the center’s Tailscale address and connect.', '填写中心的 Tailscale 地址，直接连接。') : ui('Use a credential issued by the center for this device.', '使用中心为这台机器创建的设备凭据。') : ui('Use the existing local Dot connection. Switch modes for new conversations.', '使用现有的本机 Dot 连接。切换模式后，请开启新会话。')}>
      {config.mode !== 'local' ? <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button colors={colors} disabled={busy} variant={config.transport === 'tailscale' ? 'primary' : 'outline'} label={ui('Tailscale direct', 'Tailscale 直连')} onPress={() => setDraft({ ...config, transport: 'tailscale', ...(config.mode === 'center' && state.tailscaleAddress ? { host: state.tailscaleAddress } : {}) })} />
          <Button colors={colors} disabled={busy} variant={config.transport === 'credential' ? 'outline' : 'ghost'} label={ui('Device credential', '凭据连接')} onPress={() => setDraft({ ...config, transport: 'credential' })} />
        </View>
        {config.transport === 'tailscale' ? <Text style={muted}>{ui('Devices allowed by your tailnet connect directly. Conversations bind their local workspace with reading and editing enabled.', 'Tailscale 网络内可访问此网关的机器可直接接入；会话自动绑定本机工作区并允许读写。')}</Text> : null}
      </View> : null}
      {config.mode === 'center' ? <>
        <View style={{ flexDirection: compact ? 'column' : 'row', gap: 12 }}>
          <View style={{ flex: 1 }}><Field colors={colors} label={ui('Listen address', '监听地址')} hint={ui('For Tailscale, enter this center’s 100.x IP.', '使用 Tailscale 时，填这台中心机器的 100.x 地址。')} value={config.host} editable={!busy} onChangeText={host => setDraft({ ...config, host, transport: isTailscaleIp(host) ? 'tailscale' : config.transport })} /></View>
          <View style={{ width: compact ? '100%' : 110 }}><Field colors={colors} label={ui('Port', '端口')} value={String(config.port)} editable={!busy} keyboardType="numeric" onChangeText={value => setDraft({ ...config, port: Number(value) })} /></View>
        </View>
        <View style={{ gap: 5, padding: 12, borderRadius: 8, backgroundColor: controlFill(colors) }}>
          <Text style={{ ...body, fontSize: 12, fontWeight: '600' }}>{ui('Connect over Tailscale', '通过 Tailscale 连接')}</Text>
          <Text style={muted}>{ui('On the remote, choose Tailscale direct and enter http://<center Tailscale IP>:<port>. Both devices must be connected to Tailscale and allowed to reach this port.', '远端选择「Tailscale 直连」，填 http://中心的Tailscale-IP:端口 即可。两台机器需通过 Tailscale 互通，且允许访问此端口。')}</Text>
          {['127.0.0.1', 'localhost', '::1'].includes(config.host) ? <Text style={{ ...muted, color: colors.statusWarning }}>{ui('This address only accepts local connections. Enter this machine’s Tailscale IP for direct access.', '当前地址仅接受本机连接。直连需改为这台机器的 Tailscale IP。')}</Text> : null}
        </View>
      </> : config.mode === 'remote' ? <>
        <Field colors={colors} label={ui('Center address', '中心地址')} hint={config.transport === 'tailscale' ? ui('http://<center Tailscale IP>:47823 — address and port only, without a path.', '填 http://中心的Tailscale-IP:47823，只填地址和端口，不加路径。') : ui('Enter the center origin, without a path.', '填写中心地址，不加路径。')} placeholder="https://…" value={config.url} editable={!busy} onChangeText={url => setDraft({ ...config, url, transport: isTailscaleOrigin(url) ? 'tailscale' : config.transport })} />
        {config.transport === 'credential' ? <>
        <Toggle colors={colors} disabled={busy} label={ui('Trusted private HTTP', '受信私网 HTTP')} detail={ui('Enable for HTTP over Tailscale or a trusted LAN. Not needed for HTTPS.', '通过 Tailscale 或受信局域网使用 HTTP 时开启；HTTPS 无需开启。')} value={config.privateHttp} onChange={privateHttp => setDraft({ ...config, privateHttp })} />
        <Field colors={colors} label={ui('Device credential', '设备凭据')} hint={state.tokenConfigured ? ui('Credential saved. Leave blank to keep it.', '已保存凭据，留空可保留。') : ui('Create a device on the center and paste its credential here.', '先在中心创建设备，再将生成的凭据粘贴到这里。')} secureTextEntry placeholder={state.tokenConfigured ? '••••••••' : undefined} value={token} editable={!busy} onChangeText={setToken} />
        <Field colors={colors} label={ui('Local workspace IDs', '允许的本机工作区 ID')} hint={ui('Separate IDs with commas. Current workspace: ', '多个 ID 用逗号分隔。当前工作区：') + (workspaceId ?? ui('Select a workspace first.', '请先选择工作区'))} value={config.workspaceIds.join(', ')} editable={!busy} onChangeText={value => setDraft({ ...config, workspaceIds: ids(value) })} />
        <View style={{ height: 1, backgroundColor: outline(colors) }} />{permissions(true)}
        <Text style={{ ...muted, fontSize: 11 }}>{ui('Files require permission both here and on the center. Start a new conversation after switching modes.', '文件操作需要本机和中心同时授权。切换模式后，请开启新会话。')}</Text>
        </> : <Text style={muted}>{ui('After connecting, start a new Dot conversation in your workspace.', '连接后，在工作区内新建 Dot 会话即可。')}</Text>}
      </> : null}
      <Button colors={colors} disabled={busy} label={config.mode === 'remote' ? ui('Save and connect', '保存并连接') : ui('Save settings', '保存设置')} onPress={() => {
        const next = structuredClone(config), credential = token || undefined;
        if (next.transport === 'tailscale' && next.mode !== 'local') {
          void perform(async () => { const value = await rpc(remoteConfigure, { config: next, confirm: true }); setState(value); setDraft(value.config); setToken(''); });
          return;
        }
        setPending({ kind: 'config', text: ui('Switch to ', '切换为') + modeLabel(next.mode) + '。' + (next.mode === 'center' ? ui('Open the gateway on ', '在以下地址启动设备网关：') + next.host + ':' + next.port : next.mode === 'remote' ? ui('Save the credential and connect continuously to ', '保存设备凭据并持续连接 ') + next.url + ui('. Share task text and attachments for: ', '，共享这些工作区的任务文字和附件：') + next.workspaceIds.join(', ') + ui('. Read: ', '。读取：') + allowed(next.readFiles) + ui('; edit: ', '；修改：') + allowed(next.writeFiles) + ui('; private HTTP: ', '；私网 HTTP：') + allowed(next.privateHttp) : ui('Stop multi-machine connections.', '停止多机连接。')), run: async () => { const value = await rpc(remoteConfigure, { config: next, ...(credential ? { token: credential } : {}), confirm: true }); setState(value); setDraft(value.config); setToken(''); } });
      }} />{confirmation('config')}
    </Section>
    {state.config.mode === 'center' && config.mode === 'center' && config.transport === 'credential' ? <>
      <Section colors={colors} title={ui('Add a device', '接入新设备')} description={ui('One credential per device, scoped to its remote workspaces. Chat and attachments are included.', '每台机器使用独立凭据，只授权指定的远端工作区。默认允许任务文字与附件。')}>
        <Field colors={colors} label={ui('Device name', '设备名称')} placeholder={ui('For example: coding laptop', '例如：代码工作机')} value={name} editable={!busy} onChangeText={setName} />
        <Field colors={colors} label={ui('Remote workspace IDs', '远端工作区 ID')} hint={ui('Copy IDs from the remote, not the center. Separate IDs with commas.', '从远端机器复制 ID，不是中心的工作区 ID。多个 ID 用逗号分隔。')} value={workspaces} editable={!busy} onChangeText={setWorkspaces} />
        {permissions(false)}
        <Button colors={colors} icon="Plus" disabled={busy || !name.trim() || !ids(workspaces).length} label={ui('Create device credential', '创建设备凭据')} onPress={() => {
          const input = { name: name.trim(), workspaceIds: ids(workspaces), capabilities: { chat: true, attachments: true, readFiles: read, writeFiles: write }, confirm: true as const };
          setPending({ kind: 'create', text: ui('Issue a persistent credential to ', '创建设备持续访问凭据：') + input.name + ui('. Workspaces: ', '。工作区：') + input.workspaceIds.join(', ') + ui('. Chat and attachments: allowed; read: ', '。任务文字和附件：允许；读取：') + allowed(read) + ui('; edit: ', '；修改：') + allowed(write) + ui('. Shown once; give it only to the intended device.', '。凭据仅显示本次，请只交给对应设备。'), run: async () => { const result = await rpc(remoteCreateDevice, input); setIssued(result.token); setCopied(false); await refresh(); } });
        }} />{confirmation('create')}
        {issued ? <View style={{ gap: 10, padding: 14, borderRadius: 10, backgroundColor: controlFill(colors), borderWidth: 1, borderColor: outline(colors) }}>
          <Text style={{ ...body, fontWeight: '600' }}>{ui('Copy this credential to the remote', '将凭据复制到远端机器')}</Text><Text style={muted}>{ui('Shown only this time. Keep it private.', '仅本次显示，请妥善保存。')}</Text><Text selectable style={{ ...body, fontFamily: MONO }}>{issued}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button colors={colors} variant="outline" icon="Copy" label={copied ? ui('Copied', '已复制') : ui('Copy credential', '复制凭据')} onPress={() => { void copyText(issued).then(() => setCopied(true)).catch(() => setError(ui('Could not copy. Select the credential to copy it manually.', '复制失败，请选中凭据手动复制。'))); }} />
            <Button colors={colors} variant="ghost" label={ui('Hide', '隐藏凭据')} onPress={() => setIssued('')} />
          </View>
        </View> : null}
      </Section>
      <Section colors={colors} title={ui('Authorized devices', '已授权设备') + ` · ${state.devices.filter(device => !device.revoked).length}`} description={ui('Credential status does not indicate whether a device is online.', '这里显示设备授权状态，不代表设备当前在线。')}>
        {state.devices.length ? state.devices.map(device => <View key={device.id} style={{ gap: 8, borderTopWidth: 1, borderColor: outline(colors), paddingTop: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <Text style={{ ...body, fontWeight: '600', flex: 1 }}>{device.name}</Text><Text style={{ ...muted, fontSize: 11 }}>{device.revoked ? ui('Revoked', '已撤销') : ui('Authorized', '已授权')}</Text>
            {!device.revoked ? <Button colors={colors} disabled={busy} size="xs" variant="outline" label={ui('Revoke', '撤销授权')} onPress={() => setPending({ kind: 'revoke', text: ui('Revoke persistent access for ', '撤销设备持续访问：') + device.name + ui('. Check any file operations still in progress.', '。正在执行的文件操作结果仍需核对。'), run: async () => { setState(await rpc(remoteRevokeDevice, { id: device.id, confirm: true })); } })} /> : null}
          </View><Text selectable style={{ ...muted, fontFamily: MONO, fontSize: 11 }}>{device.workspaceIds.join(', ')}</Text><Text style={{ ...muted, fontSize: 11 }}>{ui('Read: ', '读取：') + allowed(device.capabilities.readFiles) + ui(' · Edit: ', ' · 修改：') + allowed(device.capabilities.writeFiles)}</Text>
        </View>) : <Text style={muted}>{ui('No devices yet. Create a credential above to connect your first machine.', '还没有授权设备。在上方创建凭据，接入第一台机器。')}</Text>}{confirmation('revoke')}
      </Section>
    </> : null}
    {state.config.mode === 'center' && config.mode === 'center' && config.transport === 'tailscale' ? <Section colors={colors} title={ui('Tailscale devices', 'Tailscale 设备')} description={ui('Devices appear automatically on first connection. Access is controlled by your tailnet.', '机器首次连接后自动显示，访问范围由 Tailscale 网络控制。')}>
      {state.devices.filter(device => device.tailscaleIp && !device.revoked).length ? state.devices.filter(device => device.tailscaleIp && !device.revoked).map(device => <View key={device.id} style={{ gap: 5 }}><Text style={body}>{device.name}</Text><Text style={muted}>{ui('Bound workspaces: ', '已绑定工作区：') + (device.workspaceIds.join(', ') || ui('No conversations yet', '尚未发起会话'))}</Text></View>) : <Text style={muted}>{ui('Waiting for your first remote machine…', '等待第一台远端机器连接…')}</Text>}
    </Section> : null}
  </View>;
}
