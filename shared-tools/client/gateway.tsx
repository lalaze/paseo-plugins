import { useEffect, useState } from 'react';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { copyText, useToast } from '@getpaseo/plugin/client/react-native';
import { Text, View } from 'react-native';
import { ui } from '../shared/i18n';
import {
  connectRemote, createDevice, disconnectRemote, readGatewayState, refreshRemote, revokeDevice, saveGatewayConfig, updateDeviceProviders,
  type Device, type GatewayState, type Remote,
} from '../shared/gateway';
import type { ProviderRow } from '../shared/rpc';
import { Banner, Button, Card, Chip, Dot, Empty, Field, Heading, List, Muted, Switch, Tabs, type Colors } from './kit';

type Rpc = PluginClientContext['rpc'];

export interface GatewayTabProps {
  colors: Colors;
  busy: boolean;
  compact?: boolean;
  rpc: Rpc;
  state: GatewayState;
  providers: ProviderRow[];
  run(job: () => Promise<GatewayState | null>): Promise<boolean>;
}

/** Copy a value and report it, since this page runs on the app device rather than the daemon host. */
function useCopy() {
  const toast = useToast();
  return (value: string) => void copyText(value).then(
    () => toast.show(ui('Copied.', '已复制。'), { variant: 'success' }),
    () => toast.error(ui('Copying is not available here.', '此处无法复制。')),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GatewayTab(props: GatewayTabProps) {
  const { colors, state } = props;
  return <View style={{ gap: 16 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{ui('Multi-machine', '多机器')}</Text>
        <Muted colors={colors} small>{ui('Share this host’s MCP servers with other machines, or use a center’s servers here.', '把本机的 MCP 共享给其他机器，或在此使用中心的服务器。')}</Muted>
      </View>
      <Button colors={colors} icon="RefreshCw" label={ui('Refresh', '刷新')} iconOnly={props.compact} blocked={props.busy} onPress={() => void props.run(() => props.rpc(readGatewayState, {}))} />
    </View>
    <Banner tone="muted" colors={colors}>{ui(
      'MCP tools run on the center machine and the center must be online. A device uses the center account’s permissions; it never receives the center’s upstream authorization.',
      'MCP 工具在中心机器上执行，中心必须在线。设备使用中心账户的权限，但绝不会拿到中心的上游授权。',
    )}</Banner>
    {state.notes.length ? <Banner tone="warning" colors={colors}>{state.notes.join('\n')}</Banner> : null}
    <CenterCard {...props} />
    <ShareCard {...props} />
    <DevicesSection {...props} />
    <RemotesSection {...props} />
  </View>;
}

/* --------------------------------------------------------------- center */

function CenterCard(props: GatewayTabProps) {
  const { colors, state, rpc, run } = props;
  const copy = useCopy();
  const [host, setHost] = useState(state.config.host);
  const [portText, setPortText] = useState(String(state.config.port));
  const [publicUrl, setPublicUrl] = useState(state.config.publicUrl);
  useEffect(() => {
    setHost(state.config.host);
    setPortText(String(state.config.port));
    setPublicUrl(state.config.publicUrl);
  }, [state.config]);
  const port = Number(portText);
  const valid = Number.isInteger(port) && port > 0 && port <= 65535 && host.trim().length > 0;
  const save = () => run(() => rpc(saveGatewayConfig, { enabled: state.config.enabled, host: host.trim(), port, publicUrl: publicUrl.trim() }));
  const toggle = (enabled: boolean) => void run(() => rpc(saveGatewayConfig, { ...state.config, enabled }));
  return <Card colors={colors}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{ui('Center gateway', '中心网关')}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Dot color={state.running ? colors.statusSuccess : colors.foregroundMuted} />
          <Muted colors={colors} small>{state.running
            ? ui(`Listening${state.runningSince ? ` since ${new Date(state.runningSince).toLocaleTimeString()}` : ''}`, `正在监听${state.runningSince ? `（自 ${new Date(state.runningSince).toLocaleTimeString()}）` : ''}`)
            : ui('Stopped. Switch it on to let other machines connect.', '已停止。开启后其他机器才能连接。')}</Muted>
        </View>
      </View>
      <Switch colors={colors} label={ui('Gateway on', '开启网关')} value={state.config.enabled} blocked={props.busy} onChange={toggle} />
    </View>
    {state.error ? <Muted colors={colors} danger selectable>{state.error}</Muted> : null}
    <Muted colors={colors} small>{ui(
      'Plain HTTP is for Tailscale or another trusted private network; put HTTPS in front of it for the public internet.',
      '普通 HTTP 仅用于 Tailscale 或受信私网；公网请在前面加 HTTPS 反向代理。',
    )}</Muted>
    <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
      <View style={{ flex: 1, minWidth: 150 }}><Field colors={colors} label={ui('Bind address', '监听地址')} value={host} onChange={setHost} placeholder="0.0.0.0" mono /></View>
      <View style={{ width: 120 }}><Field colors={colors} label={ui('Port', '端口')} value={portText} onChange={setPortText} placeholder="47822" mono /></View>
    </View>
    <Field colors={colors} label={ui('Address other machines use', '其他机器使用的地址')} value={publicUrl} onChange={setPublicUrl} placeholder="http://100.96.195.115:47822" mono />
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
      <Button colors={colors} variant="primary" label={ui('Save', '保存')} disabled={!valid} blocked={props.busy} onPress={() => void save()} />
    </View>
    {state.localUrls.length ? <View style={{ gap: 6 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' }}>{ui('Reachable at', '可访问地址')}</Text>
      {state.localUrls.map(url => <View key={url} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Muted colors={colors} mono selectable>{url}</Muted>
        <Button colors={colors} variant="ghost" iconOnly icon="Copy" label={ui('Copy', '复制')} onPress={() => copy(url)} />
      </View>)}
    </View> : null}
  </Card>;
}

/* ------------------------------------------------------------ shareable */

function ShareCard(props: GatewayTabProps) {
  const { colors, state } = props;
  return <View style={{ gap: 8 }}>
    <Heading colors={colors} title={ui('Servers shared across machines', '跨机器共享的服务器')} count={state.shareable.length}
      hint={ui('Only enabled HTTP servers are shared. Older SSE and local stdio servers stay on this machine.', '仅共享已启用的 HTTP 服务器；旧的 SSE 与本机 stdio 服务器保留在本机。')} />
    {state.shareable.length
      ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{state.shareable.map(name => <Chip key={name} colors={colors} label={name} />)}</View>
      : <Empty colors={colors} icon="Server" title={ui('Nothing to share yet', '暂无可共享的服务器')} hint={ui('Add an enabled HTTP MCP server on the MCP tab.', '请在 MCP 标签页添加一个已启用的 HTTP MCP 服务器。')} />}
  </View>;
}

/* ------------------------------------------------------------- picker */

/** Every provider Paseo lists, in a stable order. */
function providerIds(providers: ProviderRow[]): string[] {
  return [...new Set(providers.map(row => row.id))];
}

/**
 * The multi-select used by every device and connection form: each chip toggles, a tick marks the
 * chosen ones, and Select all / Clear make the whole set one tap away. Clearing disables submit.
 */
function ProviderPicker(props: {
  colors: Colors;
  providers: ProviderRow[];
  selected: string[];
  onChange(ids: string[]): void;
  label: string;
  hint: string;
}) {
  const { colors, providers, selected } = props;
  const ids = providerIds(providers);
  const all = ids.length > 0 && ids.every(id => selected.includes(id));
  const toggle = (id: string) => props.onChange(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]);
  return <View style={{ gap: 6 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' }}>{props.label}</Text>
      <View style={{ flex: 1, minWidth: 8 }} />
      <Button colors={colors} variant="ghost" label={ui('Select all', '全选')} disabled={!ids.length || all} onPress={() => props.onChange(ids)} />
      <Button colors={colors} variant="ghost" label={ui('Clear', '清空')} disabled={!selected.length} onPress={() => props.onChange([])} />
    </View>
    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
      {ids.map(id => {
        const on = selected.includes(id);
        return <Chip key={id} colors={colors} label={providers.find(row => row.id === id)?.label ?? id} selected={on} icon={on ? 'Check' : undefined} onPress={() => toggle(id)} />;
      })}
      {!ids.length ? <Muted colors={colors} small>{ui('No providers discovered yet.', '暂未发现 Provider。')}</Muted> : null}
    </View>
    <Muted colors={colors} small>{props.hint}</Muted>
  </View>;
}

/* -------------------------------------------------------------- devices */

function DevicesSection(props: GatewayTabProps) {
  const { colors, state } = props;
  const [creating, setCreating] = useState(false);
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <View style={{ flex: 1, minWidth: 160 }}>
        <Heading colors={colors} title={ui('Device credentials', '设备凭据')} count={state.devices.length}
          hint={ui('Each credential is authorized for one or more providers and can be revoked here at any time.', '每个凭据可授权一个或多个 Provider，可随时在此撤销。')} />
      </View>
      <Button colors={colors} icon="Plus" variant="primary" label={ui('Create device', '创建设备')} blocked={props.busy} onPress={() => setCreating(value => !value)} />
    </View>
    {creating ? <CreateDevice {...props} onClose={() => setCreating(false)} /> : null}
    {state.devices.length
      ? <List colors={colors}>{state.devices.map(device => <DeviceRow key={device.id} {...props} device={device} />)}</List>
      : <Empty colors={colors} icon="MonitorSmartphone" title={ui('No devices yet', '还没有设备')} hint={ui('Create one and enter its token on the other machine.', '创建一个，然后在另一台机器输入它的令牌。')} />}
  </View>;
}

function deviceServers(device: Device): string {
  if (device.servers === null) return ui('All allowed servers', '所有获准服务器');
  if (device.servers.length === 0) return ui('No servers', '不允许任何服务器');
  return device.servers.join(', ');
}

function DeviceRow(props: GatewayTabProps & { device: Device }) {
  const { colors, device } = props;
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const revoked = device.revokedAt !== null;
  return <View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11, opacity: revoked ? 0.55 : 1 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{device.name}</Text>
          {device.providers.map(id => <Chip key={id} colors={colors} label={props.providers.find(row => row.id === id)?.label ?? id} />)}
          {revoked ? <Chip colors={colors} tone="danger" label={ui('revoked', '已撤销')} /> : null}
        </View>
        <Muted colors={colors} small lines={1}>{deviceServers(device)} · {new Date(device.createdAt).toLocaleString()}</Muted>
      </View>
      {revoked
        ? null
        : <>
          <Button colors={colors} variant="ghost" iconOnly icon="Users" label={ui('Edit providers', '编辑授权 Provider')} blocked={props.busy} onPress={() => setEditing(value => !value)} />
          {confirming
            ? <>
              <Button colors={colors} variant="danger" label={ui('Revoke', '撤销')} blocked={props.busy} onPress={() => void props.run(() => props.rpc(revokeDevice, { id: device.id })).then(ok => ok && setConfirming(false))} />
              <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setConfirming(false)} />
            </>
            : <Button colors={colors} variant="ghost" iconOnly icon="Ban" label={ui('Revoke', '撤销')} blocked={props.busy} onPress={() => setConfirming(true)} />}
        </>}
    </View>
    {editing ? <DeviceProvidersForm {...props} device={device} onClose={() => setEditing(false)} /> : null}
  </View>;
}

/** Changes which providers a device may act as, keeping the same token. */
function DeviceProvidersForm(props: GatewayTabProps & { device: Device; onClose(): void }) {
  const { colors, providers, device } = props;
  const [chosen, setChosen] = useState<string[]>(device.providers);
  const save = () => void props.run(() => props.rpc(updateDeviceProviders, { id: device.id, providers: chosen })).then(ok => ok && props.onClose());
  return <View style={{ padding: 14, gap: 12, backgroundColor: colors.surface1 }}>
    <ProviderPicker colors={colors} providers={providers} selected={chosen} onChange={setChosen}
      label={ui('Authorized providers', '授权 Provider')}
      hint={ui('The token stays the same. Removing a provider stops that provider’s running calls and sessions at once; the others keep working.', '令牌保持不变。移除某个 Provider 会立即停止该 Provider 的活动调用与会话，其余不受影响。')} />
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
      <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={props.onClose} />
      <Button colors={colors} variant="primary" label={ui('Save', '保存')} disabled={!chosen.length} blocked={props.busy} onPress={save} />
    </View>
  </View>;
}

function CreateDevice(props: GatewayTabProps & { onClose(): void }) {
  const { colors, providers, state } = props;
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>(() => providerIds(providers));
  const [mode, setMode] = useState<'all' | 'choose'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const copy = useCopy();
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const submit = () => {
    let created: string | null = null;
    void props.run(async () => {
      const result = await props.rpc(createDevice, { name: name.trim(), providers: chosen, servers: mode === 'all' ? null : selected });
      created = result.token;
      return result.state;
    }).then(ok => { if (ok && created) { setToken(created); setName(''); } });
  };
  if (token) return <Card colors={colors}>
    <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600' }}>{ui('Device token — shown only once', '设备令牌 — 仅显示一次')}</Text>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0 }}><Muted colors={colors} mono selectable>{token}</Muted></View>
      <Button colors={colors} icon="Copy" label={ui('Copy', '复制')} onPress={() => copy(token)} />
    </View>
    <Banner tone="warning" colors={colors}>{ui('Copy it now and paste it into the other machine’s connection. It cannot be shown again; if it is lost, revoke the device and create a new one.', '请立即复制并粘贴到另一台机器的连接中。它不会再次显示；若丢失，请撤销设备后重新创建。')}</Banner>
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
      <Button colors={colors} variant="primary" label={ui('Done', '完成')} onPress={props.onClose} />
    </View>
  </Card>;
  return <Card colors={colors}>
    <Field colors={colors} label={ui('Device name', '设备名称')} value={name} onChange={setName} placeholder={ui('My laptop', '我的笔记本')} />
    <ProviderPicker colors={colors} providers={providers} selected={chosen} onChange={setChosen}
      label={ui('Authorized providers', '授权 Provider')}
      hint={ui('Select every provider this device may be used as; the same token works for all of them.', '勾选该设备可使用的所有 Provider；同一个令牌通用。')} />
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' }}>{ui('Allowed servers', '允许的服务器')}</Text>
      <Tabs<'all' | 'choose'> colors={colors} small value={mode} onChange={setMode} items={[
        { id: 'all', label: ui('All allowed', '全部获准') },
        { id: 'choose', label: ui('Choose', '选择') },
      ]} />
      {mode === 'choose' ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {state.shareable.map(name => <Chip key={name} colors={colors} label={name} selected={selected.includes(name)} icon={selected.includes(name) ? 'Check' : undefined} onPress={() => toggle(name)} />)}
        {!state.shareable.length ? <Muted colors={colors} small>{ui('No shareable servers.', '暂无可共享服务器。')}</Muted> : null}
        {state.shareable.length && !selected.length ? <Muted colors={colors} small>{ui('None selected means this device may use no servers.', '不选表示该设备不允许任何服务器。')}</Muted> : null}
      </View> : null}
    </View>
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
      <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={props.onClose} />
      <Button colors={colors} variant="primary" label={ui('Create', '创建')} disabled={!name.trim() || !chosen.length} blocked={props.busy} onPress={submit} />
    </View>
  </Card>;
}

/* -------------------------------------------------------------- remotes */

function RemotesSection(props: GatewayTabProps) {
  const { colors, state } = props;
  const [adding, setAdding] = useState(false);
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <View style={{ flex: 1, minWidth: 160 }}>
        <Heading colors={colors} title={ui('Connections to a center', '连接的中心')} count={state.remotes.length}
          hint={ui('A saved center URL and device token. New agents of the matching provider get its servers.', '保存的中心 URL 与设备令牌；匹配 Provider 的新 Agent 会获得其服务器。')} />
      </View>
      <Button colors={colors} icon="Plus" variant="primary" label={ui('Connect', '连接')} blocked={props.busy} onPress={() => setAdding(value => !value)} />
    </View>
    {adding ? <ConnectRemote {...props} onClose={() => setAdding(false)} /> : null}
    {state.remotes.length
      ? <List colors={colors}>{state.remotes.map(remote => <RemoteRow key={remote.id} {...props} remote={remote} />)}</List>
      : <Empty colors={colors} icon="Plug" title={ui('No center connection yet', '还没有连接中心')} hint={ui('On the center, create a device, then paste its URL and token here.', '在中心创建设备，然后把它的 URL 和令牌粘贴到这里。')} />}
  </View>;
}

function RemoteRow(props: GatewayTabProps & { remote: Remote }) {
  const { colors, remote } = props;
  const [confirming, setConfirming] = useState(false);
  const tone = remote.status === 'ok' ? 'success' : remote.status === 'error' ? 'danger' : 'warning';
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11 }}>
    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{remote.name}</Text>
        <Chip colors={colors} label={props.providers.find(row => row.id === remote.provider)?.label ?? remote.provider} />
        <Chip colors={colors} tone={tone} label={remote.status === 'ok'
          ? ui(`${remote.catalog.length} servers`, `${remote.catalog.length} 个服务器`)
          : remote.status === 'error' ? ui('offline', '离线') : ui('not checked', '未检查')} />
      </View>
      <Muted colors={colors} mono small lines={1} selectable>{remote.url}</Muted>
      {remote.error ? <Muted colors={colors} small danger>{remote.error}</Muted> : null}
      {remote.catalog.length ? <Muted colors={colors} small lines={1}>{remote.catalog.map(server => server.name).join(', ')}</Muted> : null}
    </View>
    {confirming
      ? <>
        <Button colors={colors} variant="danger" label={ui('Disconnect', '断开')} blocked={props.busy} onPress={() => void props.run(() => props.rpc(disconnectRemote, { id: remote.id })).then(ok => ok && setConfirming(false))} />
        <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setConfirming(false)} />
      </>
      : <>
        <Button colors={colors} variant="ghost" iconOnly icon="RefreshCw" label={ui('Check now', '立即检查')} blocked={props.busy} onPress={() => void props.run(() => props.rpc(refreshRemote, { id: remote.id }))} />
        <Button colors={colors} variant="ghost" iconOnly icon="Unplug" label={ui('Disconnect', '断开')} blocked={props.busy} onPress={() => setConfirming(true)} />
      </>}
  </View>;
}

function ConnectRemote(props: GatewayTabProps & { onClose(): void }) {
  const { colors, providers } = props;
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [chosen, setChosen] = useState<string[]>(() => { const first = providers[0]?.id; return first ? [first] : []; });
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    setProblem(null);
    void props.run(async () => {
      try {
        return await props.rpc(connectRemote, { name: name.trim(), url: url.trim(), token: token.trim(), providers: chosen });
      } catch (error) {
        setProblem(message(error));
        throw error;
      }
    }).then(ok => {
      if (!ok) return;
      setProblem(null);
      props.onClose();
    });
  };
  return <Card colors={colors}>
    <Field colors={colors} label={ui('Name', '名称')} value={name} onChange={setName} placeholder={ui('Center', '中心')} />
    <Field colors={colors} label={ui('Center URL', '中心 URL')} value={url} onChange={setUrl} placeholder="http://100.96.195.115:47822" mono />
    <Field colors={colors} label={ui('Device token', '设备令牌')} value={token} onChange={setToken} secure placeholder={ui('Paste the token shown at creation', '粘贴创建时显示的令牌')} mono />
    <ProviderPicker colors={colors} providers={providers} selected={chosen} onChange={setChosen}
      label={ui('Providers this token is authorized for', '该令牌已授权的 Provider')}
      hint={ui('One connection is saved per provider with the same token. A provider the center does not allow is saved as an error and is not added to agents.', '每个 Provider 会用同一令牌各保存一条连接。中心不允许的 Provider 会保存为错误，且不会加入 Agent。')} />
    {problem ? <Muted colors={colors} danger selectable>{problem}</Muted> : null}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
      <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={props.onClose} />
      <Button colors={colors} variant="primary" label={ui('Connect', '连接')} disabled={!name.trim() || !url.trim() || !token.trim() || !chosen.length} blocked={props.busy} onPress={submit} />
    </View>
  </Card>;
}
