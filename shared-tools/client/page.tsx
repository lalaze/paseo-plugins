import { useCallback, useEffect, useRef, useState } from 'react';
import { openExternalUrl, type PluginClientContext, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { copyText, Icon, ScrollView, useToast } from '@getpaseo/plugin/client/react-native';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { blankDraft, draftFrom, hasAuthHeader, matchesQuery, serverFromDraft, summarize, type ServerDraft } from '../shared/form';
import { ui } from '../shared/i18n';
import { accessMode, type AccessMode } from '../shared/access';
import {
  cancelSignIn, deleteMcpServer, deleteSkill, finishSignIn, importMcpServers, importSkill, overwriteSkill, readState, saveMcpServer,
  signInStatus, signOut, startSignIn, syncSkills, updateProvider, updateSkillAccess,
  type FoundSkill, type McpServer, type ProviderAccess, type ProviderRow, type SharedState, type SkillRow, type TargetStatus,
} from '../shared/rpc';
import { Banner, Button, Card, Chip, Dot, Empty, Field, Heading, List, MONO, Muted, Switch, Tabs, type Colors } from './kit';

type Rpc = PluginClientContext['rpc'];
type Tab = 'mcp' | 'skills' | 'providers';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const statusLabels: Record<TargetStatus, string> = {
  synced: ui('synced', '已同步'),
  modified: ui('edited there', '在该处被改过'),
  conflict: ui('name taken', '同名冲突'),
  error: ui('failed', '失败'),
};
const statusTones = { synced: 'success', modified: 'warning', conflict: 'warning', error: 'danger' } as const;

/** A copy needs a look when it is not in sync or the last sync left a message on it. */
function needsLook(target: SkillRow['targets'][number]): boolean {
  return target.status !== 'synced' || target.message !== null;
}

export function SharedToolsPage(props: PluginSurfaceProps & { rpc: Rpc }) {
  const { colors } = props.theme;
  const [state, setState] = useState<SharedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('mcp');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /** Runs one change; every RPC answers with the whole new state. */
  const run = useCallback(async (job: () => Promise<SharedState | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await job();
      if (alive.current && next) setState(next);
      return true;
    } catch (cause) {
      if (alive.current) setError(message(cause));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  useEffect(() => { void run(() => props.rpc(readState, {})); }, [run, props.rpc]);

  const providerLabel = (id: string) => state?.providers.find(p => p.id === id)?.label ?? id;
  const section = { colors, busy, rpc: props.rpc, run, providerLabel };
  const compact = props.layout.compact;

  return <ScrollView contentContainerStyle={{ padding: compact ? 14 : 24, paddingBottom: 48 }}>
    <View style={{ width: '100%', maxWidth: 820, alignSelf: 'center', gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: '700' }}>{ui('Shared MCP & skills', '共享 MCP 与技能')}</Text>
          <Muted colors={colors}>{ui(
            `Share MCP servers and skills with selected providers on ${props.host.label}.`,
            `在 ${props.host.label} 上按 Provider 共享 MCP 服务器和技能。`,
          )}</Muted>
        </View>
        <Button colors={colors} icon="RefreshCw" label={ui('Sync now', '立即同步')} iconOnly={compact} blocked={busy} onPress={() => void run(() => props.rpc(syncSkills, {}))} />
      </View>
      {state ? <Tabs<Tab> colors={colors} value={tab} onChange={setTab} items={[
        { id: 'mcp', label: ui('MCP servers', 'MCP 服务器'), count: state.mcpServers.length },
        { id: 'skills', label: ui('Skills', '技能'), count: state.skills.length, alert: state.notes.length > 0 || state.skills.some(skill => skill.targets.some(needsLook)) },
        { id: 'providers', label: 'Provider', count: state.providers.filter(row => row.present).length },
      ]} /> : null}
      {error ? <Banner tone="danger" colors={colors} onClose={() => setError(null)}>{error}</Banner> : null}
      {state === null
        ? error ? null : <ActivityIndicator color={colors.foregroundMuted} style={{ paddingVertical: 32 }} />
        : tab === 'mcp' ? <McpTab {...section} state={state} />
        : tab === 'skills' ? <SkillsTab {...section} state={state} />
        : <ProvidersTab {...section} state={state} />}
      {state ? <Muted colors={colors} small selectable>
        {ui('Data folder', '数据目录')} {state.dataDir}{state.syncedAt ? ` · ${ui('last synced', '上次同步')} ${new Date(state.syncedAt).toLocaleString()}` : ''}
      </Muted> : null}
    </View>
  </ScrollView>;
}

interface TabProps {
  state: SharedState;
  colors: Colors;
  busy: boolean;
  rpc: Rpc;
  run(job: () => Promise<SharedState | null>): Promise<boolean>;
  providerLabel(id: string): string;
}

function AccessSummary(props: Pick<TabProps, 'colors' | 'providerLabel'> & { access: ProviderAccess }) {
  const { access } = props;
  const labels = (ids: string[]) => ids.map(props.providerLabel).join(', ');
  return <>
    {access.providers !== null ? <Chip colors={props.colors} label={access.providers.length
      ? `${ui('Allowlist', '白名单')}: ${labels(access.providers)}` : ui('Allowlist: nobody', '白名单：不允许任何 Provider')} /> : null}
    {access.excludedProviders?.length ? <Chip colors={props.colors} tone="warning" label={`${ui('Denylist', '黑名单')}: ${labels(access.excludedProviders)}`} /> : null}
  </>;
}

/** The same permission controls serve both MCP servers and library skills. */
function AccessFields(props: TabProps & { access: ProviderAccess; onChange(access: ProviderAccess): void; kind?: 'mcp' | 'skills' }) {
  const { colors, access } = props;
  const [mode, setMode] = useState<AccessMode>(() => accessMode(access));
  const selected = mode === 'allow' ? access.providers ?? [] : access.excludedProviders ?? [];
  const changeMode = (next: AccessMode) => {
    if (next === mode) return;
    setMode(next);
    props.onChange({ providers: next === 'allow' ? [] : null, excludedProviders: [] });
  };
  const toggle = (id: string) => {
    const ids = selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id];
    props.onChange(mode === 'allow' ? { providers: ids, excludedProviders: [] } : { providers: null, excludedProviders: ids });
  };
  const ids = [...new Set([...props.state.providers.map(row => row.id), ...(access.providers ?? []), ...(access.excludedProviders ?? [])])];
  return <View style={{ gap: 8 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' }}>{ui('Provider permissions', 'Provider 权限')}</Text>
    <Tabs<AccessMode> colors={colors} small value={mode} onChange={changeMode} items={[
      { id: 'all', label: ui('Allow all', '全部允许') },
      { id: 'allow', label: ui('Allowlist', '白名单') },
      { id: 'deny', label: ui('Denylist', '黑名单') },
    ]} />
    <Muted colors={colors} small>{mode === 'allow'
      ? ui('Only selected providers are allowed. An empty list allows nobody.', '仅允许选中的 Provider；不选表示全部禁止。')
      : mode === 'deny' ? ui('Selected providers are denied; all others are allowed.', '禁止选中的 Provider，其余全部允许。')
      : ui('All providers are allowed, including new ones.', '允许所有 Provider，包括之后新增的。')}</Muted>
    {mode !== 'all' ? <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
      {ids.map(id => <Chip key={id} colors={colors} label={props.providerLabel(id)} selected={selected.includes(id)} onPress={() => toggle(id)} />)}
      {!ids.length ? <Muted colors={colors} small>{ui('No providers discovered yet.', '暂未发现 Provider。')}</Muted> : null}
    </View> : null}
    <Muted colors={colors} small>{props.kind === 'skills'
      ? ui('The provider’s Skills switch must also be on. Saving removes untouched managed copies from denied providers; edited or independent copies are kept. Providers sharing a folder need matching permissions or separate folders.', '还需开启 Provider 的技能总开关。保存后会移除被禁止方的未改动托管副本；改过或独立的副本会保留。共用目录的 Provider 需设置相同权限或分开目录。')
      : ui('The provider’s MCP switch must also be on. Applies to new agents.', '还需开启 Provider 的 MCP 总开关；对新建 Agent 生效。')}</Muted>
  </View>;
}

function AccessPanel(props: TabProps & { access: ProviderAccess; kind?: 'mcp' | 'skills'; onSave(access: ProviderAccess): Promise<boolean>; onClose(): void }) {
  const [access, setAccess] = useState<ProviderAccess>({ providers: props.access.providers, excludedProviders: props.access.excludedProviders ?? [] });
  return <View style={{ margin: 12, padding: 12, gap: 12, borderRadius: 8, backgroundColor: props.colors.surface2 }}>
    <AccessFields {...props} access={access} onChange={setAccess} />
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
      <Button colors={props.colors} variant="ghost" label={ui('Cancel', '取消')} onPress={props.onClose} />
      <Button colors={props.colors} variant="primary" label={ui('Save', '保存')} blocked={props.busy}
        onPress={() => void props.onSave(access).then(ok => ok && props.onClose())} />
    </View>
  </View>;
}

/* ---------------------------------------------------------------- MCP */

function McpTab(props: TabProps) {
  const { state, colors } = props;
  const toast = useToast();
  /** Name of the server being edited, `''` for a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [json, setJson] = useState('');

  const doImport = (source: 'claude' | 'codex' | 'json') => props.run(async () => {
    const result = await props.rpc(importMcpServers, { source, ...(source === 'json' ? { json } : {}), replace: false });
    const lines = [
      result.imported.length ? `${ui('Imported', '已导入')}: ${result.imported.join(', ')}` : ui('Nothing new to import.', '没有可导入的新服务器。'),
      ...result.skipped.map(line => `${ui('Skipped', '已跳过')} ${line}`),
    ];
    toast.show(lines.join('\n'), { variant: result.imported.length ? 'success' : 'info' });
    if (result.imported.length) { setJson(''); setPasting(false); setImporting(false); }
    return result.state;
  });

  return <View style={{ gap: 12 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <View style={{ flex: 1, minWidth: 200 }}>
        <Muted colors={colors}>{ui('Added to new agents of providers with MCP on. Running agents keep theirs.', '开启 MCP 的 Provider 新建 Agent 时自动加入，已运行的 Agent 不受影响。')}</Muted>
      </View>
      <Button colors={colors} icon="Download" label={ui('Import', '导入')} active={importing} blocked={props.busy} onPress={() => setImporting(value => !value)} />
      <Button colors={colors} icon="Plus" variant="primary" label={ui('Add server', '添加服务器')} blocked={props.busy} onPress={() => setEditing('')} />
    </View>

    {importing ? <Card colors={colors}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600', marginRight: 4 }}>{ui('Import from', '导入自')}</Text>
        <Button colors={colors} label="Claude Code" blocked={props.busy} onPress={() => void doImport('claude')} />
        <Button colors={colors} label="Codex" blocked={props.busy} onPress={() => void doImport('codex')} />
        <Button colors={colors} icon="ClipboardPaste" label={ui('Paste JSON', '粘贴 JSON')} active={pasting} onPress={() => setPasting(value => !value)} />
        <View style={{ flex: 1 }} />
        <Button colors={colors} variant="ghost" iconOnly icon="X" label={ui('Close', '关闭')} onPress={() => { setImporting(false); setPasting(false); }} />
      </View>
      {pasting ? <>
        <Field colors={colors} label={ui('An "mcpServers" object, as in Claude Code, Cursor or Gemini settings', '“mcpServers” 对象，格式同 Claude Code、Cursor 或 Gemini 的配置')} value={json} onChange={setJson} multiline mono
          placeholder={'{ "mcpServers": { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } } }'} />
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Button colors={colors} variant="primary" label={ui('Import', '导入')} disabled={!json.trim()} blocked={props.busy} onPress={() => void doImport('json')} />
        </View>
      </> : <Muted colors={colors} small>{ui('Servers whose names are already shared are skipped.', '已共享的同名服务器会被跳过。')}</Muted>}
    </Card> : null}

    {editing === '' ? <List colors={colors}><ServerForm {...props} draft={blankDraft()} previousName={null} onClose={() => setEditing(null)} /></List> : null}

    {state.mcpServers.length
      ? <List colors={colors}>
        {state.mcpServers.map(server => editing === server.name
          ? <ServerForm key={server.name} {...props} draft={draftFrom(server)} previousName={server.name} onClose={() => setEditing(null)} />
          : <ServerRow key={server.name} {...props} server={server} onEdit={() => setEditing(server.name)} />)}
      </List>
      : editing === '' ? null : <Empty colors={colors} icon="Server" title={ui('No shared servers yet', '还没有共享的 MCP 服务器')}
        hint={ui('Add one, or import the servers Claude Code or Codex already has.', '添加一个，或从 Claude Code、Codex 导入已有的服务器。')} />}
  </View>;
}

function ServerRow(props: TabProps & { server: McpServer; onEdit(): void }) {
  const { server, colors } = props;
  const [confirming, setConfirming] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  /** The switch answers on the press itself; the round trip then brings the same value back. */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const auth = props.state.auth[server.name];
  const canSignIn = server.config.type !== 'stdio' && !hasAuthHeader(server.config);
  const on = enabled ?? server.enabled;
  const save = (patch: Partial<McpServer>) => props.run(() => props.rpc(saveMcpServer, { ...server, ...patch, previousName: server.name }));
  const toggle = (value: boolean) => { setEnabled(value); void save({ enabled: value }).then(() => setEnabled(null)); };
  return <View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 3, opacity: on ? 1 : 0.55 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{server.name}</Text>
          <Chip colors={colors} label={server.config.type} />
          <AccessSummary {...props} access={server} />
          {canSignIn && auth ? <Chip colors={colors} tone={auth.status === 'signed-in' ? 'success' : 'warning'}
            label={auth.status === 'signed-in' ? ui('signed in', '已登录') : ui('sign-in expired', '登录已过期')} /> : null}
          {canSignIn && auth?.source ? <Chip colors={colors} label={ui(`via ${auth.source}`, `来自 ${auth.source}`)} /> : null}
        </View>
        <Muted colors={colors} mono lines={1} selectable>{summarize(server.config)}</Muted>
      </View>
      {confirming
        ? <>
          <Button colors={colors} variant="danger" label={ui('Delete', '删除')} blocked={props.busy} onPress={() => void props.run(() => props.rpc(deleteMcpServer, { name: server.name }))} />
          <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setConfirming(false)} />
        </>
        : <>
          {canSignIn && !signingIn
            ? auth?.status === 'signed-in'
              ? <Button colors={colors} variant="ghost" iconOnly icon="LogOut" label={ui('Sign out', '退出登录')} blocked={props.busy} onPress={() => void props.run(() => props.rpc(signOut, { name: server.name }))} />
              : <Button colors={colors} variant="ghost" icon="LogIn" label={auth ? ui('Sign in again', '重新登录') : ui('Find authorization / sign in', '查找授权 / 登录')} blocked={props.busy} onPress={() => setSigningIn(true)} />
            : null}
          <Button colors={colors} variant="ghost" iconOnly icon="Users" label={ui('Provider permissions', 'Provider 权限')} blocked={props.busy} onPress={() => setAccessOpen(value => !value)} />
          <Button colors={colors} variant="ghost" iconOnly icon="Pencil" label={ui('Edit', '编辑')} blocked={props.busy} onPress={props.onEdit} />
          <Button colors={colors} variant="ghost" iconOnly icon="Trash2" label={ui('Delete', '删除')} blocked={props.busy} onPress={() => setConfirming(true)} />
        </>}
      <Switch colors={colors} label={`${server.name} ${ui('on', '开启')}`} value={on} blocked={props.busy} onChange={toggle} />
    </View>
    {accessOpen ? <AccessPanel {...props} access={server} onClose={() => setAccessOpen(false)} onSave={access => save(access)} /> : null}
    {signingIn ? <SignInPanel {...props} name={server.name} canUseCodex={server.config.type === 'http'} onClose={() => setSigningIn(false)} /> : null}
  </View>;
}

const POLL_MS = 2000;

/** Rejects instead of throwing, also on a host whose app does not offer an external opener. */
function openLink(url: string): Promise<void> {
  return Promise.resolve().then(() => openExternalUrl(url));
}

/**
 * The browser step runs on this device; the host catches the redirect itself when it can
 * (same machine, or the port forwarded over SSH), and the pasted address finishes it otherwise.
 */
function SignInPanel(props: TabProps & { name: string; canUseCodex: boolean; onClose(): void }) {
  const { colors, name, rpc, run, onClose } = props;
  const toast = useToast();
  const [flow, setFlow] = useState<{ authorizationUrl: string; redirectUri: string; listening: boolean; via?: 'codex' } | null>(null);
  const [callback, setCallback] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const live = useRef(true);
  const callbacks = useRef({ toast, onClose });
  callbacks.current = { toast, onClose };
  useEffect(() => () => { live.current = false; }, []);

  const finished = useCallback(async (next: SharedState | null) => {
    toast.show(ui(`Signed in to ${name}. New agents get the token.`, `已登录 ${name}，新建的 Agent 会带上令牌。`), { variant: 'success' });
    await run(async () => next ?? await rpc(readState, {}));
    if (live.current) onClose();
  }, [name, onClose, rpc, run, toast]);

  const begin = useCallback(async (reuseExisting = true, via?: 'codex') => {
    setStarting(true);
    setProblem(null);
    try {
      const started = await rpc(startSignIn, { name, reuseExisting, via });
      if (!live.current) return;
      if (started.reused) {
        callbacks.current.toast.show(ui(`Using the MCP authorization from ${started.source}.`, `已复用 ${started.source} 的 MCP 授权。`), { variant: 'success' });
        await run(() => rpc(readState, {}));
        if (live.current) callbacks.current.onClose();
        return;
      }
      setFlow(started);
      await openLink(started.authorizationUrl).catch(() => {
        if (live.current) setProblem(ui('Could not open a browser here; copy the link below instead.', '无法在此打开浏览器，请复制下方链接。'));
      });
    } catch (cause) {
      if (live.current) setProblem(message(cause));
    } finally {
      if (live.current) setStarting(false);
    }
  }, [name, rpc, run]);

  useEffect(() => { void begin(); }, [begin]);

  // The host may finish on its own when the redirect reaches its port.
  useEffect(() => {
    if (!flow || (!flow.listening && flow.via !== 'codex')) return;
    let stopped = false;
    const timer = setInterval(() => {
      void rpc(signInStatus, { name }).then(result => {
        if (stopped || !live.current) return;
        if (result.status === 'done') { stopped = true; clearInterval(timer); void finished(null); }
        else if (result.status === 'failed') setProblem(result.error);
      }).catch(() => undefined);
    }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [flow, finished, name, rpc]);

  const finish = async () => {
    setProblem(null);
    try {
      const next = await rpc(finishSignIn, { name, callback });
      await finished(next);
    } catch (cause) {
      if (live.current) setProblem(message(cause));
    }
  };
  const cancel = () => { void rpc(cancelSignIn, { name }).catch(() => undefined); onClose(); };
  const port = flow ? new URL(flow.redirectUri).port : '';

  return <View style={{ marginHorizontal: 14, marginBottom: 12, padding: 12, gap: 10, borderRadius: 8, backgroundColor: colors.surface2 }}>
    {starting && !flow
      ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <ActivityIndicator size="small" color={colors.foregroundMuted} />
        <Muted colors={colors}>{ui('Looking for existing MCP authorization…', '正在查找已有 MCP 授权…')}</Muted>
      </View>
      : null}
    {flow ? <>
      {flow.via === 'codex' ? <Muted colors={colors}>{ui('Codex is handling this authorization. After approval, paste the final browser address below; new agents will use its saved credential.', '此授权由 Codex 发起。浏览器授权后，请将最后停留的地址粘贴到下方；新建 Agent 会复用其保存的凭据。')}</Muted> : null}
      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600' }}>{ui('1. Approve access in the browser on this device', '1. 在本设备的浏览器中授权')}</Text>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Button colors={colors} icon="ExternalLink" label={ui('Open again', '重新打开')} onPress={() => void openLink(flow.authorizationUrl).catch(() => undefined)} />
          <Button colors={colors} icon="Copy" label={ui('Copy link', '复制链接')} onPress={() => void copyText(flow.authorizationUrl).then(
            () => toast.show(ui('Link copied.', '链接已复制。'), { variant: 'success' }),
            () => toast.error(ui('Copying is not available here.', '此处无法复制。')),
          )} />
        </View>
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600' }}>{ui('2. Paste the address the browser ends on', '2. 粘贴浏览器最后停留的地址')}</Text>
        <Muted colors={colors} small>{ui(
          `After you approve, the browser goes to ${flow.redirectUri}. When the host is another machine that page does not load; copy its full address from the address bar and paste it here.`,
          `授权后浏览器会跳转到 ${flow.redirectUri}。若主机是另一台机器，该页面无法打开；从地址栏复制完整地址粘贴到这里即可。`,
        )}</Muted>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Field colors={colors} value={callback} onChange={setCallback} onSubmit={() => { if (callback.trim()) void finish(); }} placeholder={`${flow.redirectUri}?code=…&state=…`} mono />
          </View>
          <Button colors={colors} variant="primary" label={ui('Finish', '完成')} disabled={!callback.trim()} blocked={props.busy} onPress={() => void finish()} />
        </View>
        <Muted colors={colors} small>{flow.via === 'codex'
          ? ui('Paste the full callback address even if the browser says the page cannot load.', '即使浏览器提示页面无法打开，也请复制完整回调地址粘贴到这里。')
          : flow.listening
          ? ui(
            `On the host itself, or with the port forwarded (ssh -L ${port}:localhost:${port} …), this finishes on its own.`,
            `在主机本机上，或已转发端口（ssh -L ${port}:localhost:${port} …）时，会自动完成。`,
          )
          : ui(`Port ${port} is in use on the host, so only pasting finishes this.`, `主机上的 ${port} 端口已被占用，只能粘贴地址完成。`)}</Muted>
      </View>
    </> : null}
    {problem ? <Muted colors={colors} danger selectable>{problem}</Muted> : null}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 6 }}>
      {problem && !flow ? <Button colors={colors} label={ui('Try again', '重试')} disabled={starting} onPress={() => void begin()} /> : null}
      {!flow && props.canUseCodex ? <Button colors={colors} label={ui('Authorize with Codex', '通过 Codex 授权')} disabled={starting} onPress={() => void begin(false, 'codex')} /> : null}
      {problem && !flow ? <Button colors={colors} label={ui('Browser sign-in', '浏览器重新授权')} disabled={starting} onPress={() => void begin(false)} /> : null}
      <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={cancel} />
    </View>
  </View>;
}

function ServerForm(props: TabProps & { draft: ServerDraft; previousName: string | null; onClose(): void }) {
  const { colors } = props;
  const [draft, setDraft] = useState(props.draft);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<ServerDraft>) => setDraft(current => ({ ...current, ...patch }));
  const submit = () => {
    const result = serverFromDraft(draft);
    if ('error' in result) { setProblem(result.error); return; }
    setProblem(null);
    void props.run(() => props.rpc(saveMcpServer, { ...result.server, previousName: props.previousName })).then(ok => ok && props.onClose());
  };
  return <View style={{ padding: 14, gap: 12, backgroundColor: colors.surface1 }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
      <View style={{ flex: 1, minWidth: 180 }}>
        <Field colors={colors} label={ui('Name', '名称')} value={draft.name} onChange={name => set({ name })} placeholder="context7" />
      </View>
      <Tabs colors={colors} small value={draft.type} onChange={type => set({ type })}
        items={[{ id: 'stdio', label: 'stdio' }, { id: 'http', label: 'http' }, { id: 'sse', label: 'sse' }]} />
    </View>
    {draft.type === 'stdio'
      ? <>
        <Field colors={colors} label={ui('Command', '命令')} value={draft.command} onChange={command => set({ command })} placeholder="npx" mono />
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <View style={{ flex: 1, minWidth: 200 }}>
            <Field colors={colors} label={ui('Arguments, one per line', '参数，每行一个')} value={draft.args} onChange={args => set({ args })} multiline mono placeholder={'-y\n@upstash/context7-mcp'} />
          </View>
          <View style={{ flex: 1, minWidth: 200 }}>
            <Field colors={colors} label={ui('Environment, KEY=value per line', '环境变量，每行 KEY=value')} value={draft.env} onChange={env => set({ env })} multiline mono placeholder="API_KEY=…" />
          </View>
        </View>
      </>
      : <>
        <Field colors={colors} label="URL" value={draft.url} onChange={url => set({ url })} placeholder="https://example.com/mcp" mono />
        <Field colors={colors} label={ui('Headers, Name: value per line', '请求头，每行 Name: value')} value={draft.headers} onChange={headers => set({ headers })} multiline mono placeholder="Authorization: Bearer …" />
      </>}
    <AccessFields {...props} access={draft} onChange={set} />
    {problem ? <Muted colors={colors} danger>{problem}</Muted> : null}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
      <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={props.onClose} />
      <Button colors={colors} variant="primary" label={ui('Save', '保存')} blocked={props.busy} onPress={submit} />
    </View>
  </View>;
}

/* ------------------------------------------------------------- Skills */

function SkillsTab(props: TabProps) {
  const { state, colors } = props;
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [foundOpen, setFoundOpen] = useState<boolean | null>(null);
  const skills = state.skills.filter(skill => matchesQuery(query, skill.name, skill.description));
  const found = state.found.filter(row => matchesQuery(query, row.name, row.description, props.providerLabel(row.provider)));
  const filtered = query.trim() !== '';
  // Folded once the library has skills, unless a search is narrowing it down.
  const showFound = filtered || (foundOpen ?? state.skills.length === 0);
  const count = (shown: number, total: number) => filtered ? `${shown}/${total}` : total;
  const addPath = () => void props.run(() => props.rpc(importSkill, { path, replace: false })).then(ok => { if (ok) { setPath(''); setAdding(false); } });

  return <View style={{ gap: 16 }}>
    {state.notes.length ? <Banner tone="warning" colors={props.colors}>{state.notes.join('\n')}</Banner> : null}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {state.skills.length + state.found.length > 0
        ? <View style={{ flex: 1, minWidth: 200 }}>
          <Field colors={colors} icon="Search" value={query} onChange={setQuery} placeholder={ui('Search by name, description or provider', '按名称、描述或 Provider 搜索')} />
        </View>
        : <View style={{ flex: 1 }} />}
      <Button colors={colors} icon="FolderPlus" label={ui('Add folder', '添加文件夹')} active={adding} blocked={props.busy} onPress={() => setAdding(value => !value)} />
    </View>

    {adding ? <Card colors={colors}>
      <Field colors={colors} label={ui('A skill folder with a SKILL.md, from anywhere', '含 SKILL.md 的技能文件夹，可在任意位置')} value={path} onChange={setPath} onSubmit={addPath} placeholder="~/Downloads/my-skill" mono />
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
        <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setAdding(false)} />
        <Button colors={colors} variant="primary" label={ui('Add to library', '加入技能库')} disabled={!path.trim()} blocked={props.busy} onPress={addPath} />
      </View>
    </Card> : null}

    {filtered && skills.length + found.length === 0
      ? <Empty colors={colors} icon="SearchX" title={ui(`No skills match “${query.trim()}”`, `没有匹配“${query.trim()}”的技能`)} />
      : <>
        {!filtered || skills.length ? <View style={{ gap: 8 }}>
          <Heading colors={colors} title={ui('Library', '技能库')} count={count(skills.length, state.skills.length)}
            hint={ui('Copied to allowed providers with skills on. Copies edited there are preserved.', '复制到获准且开启技能的 Provider；在 Provider 里改过的副本会保留。')} />
          {state.skills.length === 0
            ? <Empty colors={colors} icon="BookOpen" title={ui('The library is empty', '技能库是空的')}
              hint={ui('Add skills your providers already have from the list below, or add a folder with a SKILL.md.', '从下方列表加入各 Provider 已有的技能，或添加含 SKILL.md 的文件夹。')} />
            : <List colors={colors}>{skills.map(skill => <SkillItem key={skill.name} {...props} skill={skill} />)}</List>}
          <Muted colors={colors} mono lines={1} selectable>{state.libraryDir}</Muted>
        </View> : null}

        {found.length ? <View style={{ gap: 8 }}>
          <Heading colors={colors} title={ui('Found in provider folders', '在 Provider 目录中发现')} count={count(found.length, state.found.length)}
            open={showFound} onToggle={filtered ? undefined : () => setFoundOpen(!showFound)} />
          {showFound ? <List colors={colors}>{found.map(row => <FoundItem key={row.path} {...props} found={row} />)}</List> : null}
        </View> : null}
      </>}
  </View>;
}

function SkillItem(props: TabProps & { skill: SkillRow }) {
  const { skill, colors } = props;
  const [confirming, setConfirming] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const synced = skill.targets.filter(target => !needsLook(target));
  const issues = skill.targets.filter(needsLook);
  const opened = issues.find(target => target.provider === open);
  return <View style={{ paddingHorizontal: 14, paddingVertical: 11, gap: 7 }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{skill.name}</Text>
          <AccessSummary {...props} access={skill} />
        </View>
        {skill.description ? <Muted colors={colors} small lines={2}>{skill.description}</Muted> : null}
      </View>
      <Button colors={colors} variant="ghost" iconOnly icon="Users" label={ui('Provider permissions', 'Provider 权限')} blocked={props.busy} onPress={() => setAccessOpen(value => !value)} />
      {confirming
        ? <>
          <Button colors={colors} variant="danger" label={ui('Remove everywhere', '从所有位置移除')} blocked={props.busy} onPress={() => void props.run(() => props.rpc(deleteSkill, { name: skill.name }))} />
          <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setConfirming(false)} />
        </>
        : <Button colors={colors} variant="ghost" iconOnly icon="Trash2" label={ui('Remove', '移除')} blocked={props.busy} onPress={() => setConfirming(true)} />}
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {synced.length
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 }}>
          <Dot color={colors.statusSuccess} />
          <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11, flexShrink: 1 }}>{statusLabels.synced} · {synced.map(target => props.providerLabel(target.provider)).join(', ')}</Text>
        </View>
        : null}
      {issues.map(target => <Chip key={target.provider} colors={colors} tone={statusTones[target.status]} selected={open === target.provider}
        label={`${props.providerLabel(target.provider)} · ${statusLabels[target.status]}`}
        onPress={() => setOpen(current => current === target.provider ? null : target.provider)} />)}
      {skill.targets.length === 0 ? <Muted colors={colors} small>{ui('No allowed provider has skills on.', '没有获准且开启技能的 Provider。')}</Muted> : null}
    </View>
    {accessOpen ? <AccessPanel {...props} kind="skills" access={skill} onClose={() => setAccessOpen(false)}
      onSave={access => props.run(() => props.rpc(updateSkillAccess, { name: skill.name, ...access }))} /> : null}
    {confirming ? <Muted colors={colors} small>{ui('Moves the library copy to the backups and removes the untouched copies from every provider.', '把技能库中的副本移到备份目录，并从各 Provider 删除未改动的副本。')}</Muted> : null}
    {opened ? <View style={{ gap: 8, padding: 10, borderRadius: 8, backgroundColor: colors.surface2 }}>
      {opened.message ? <Muted colors={colors} selectable danger={opened.status === 'error'}>{opened.message}</Muted> : null}
      {opened.status === 'modified' || opened.status === 'conflict'
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Button colors={colors} icon="Replace" label={ui(`Replace ${props.providerLabel(opened.provider)}'s copy`, `替换 ${props.providerLabel(opened.provider)} 的副本`)} blocked={props.busy}
            onPress={() => void props.run(() => props.rpc(overwriteSkill, { name: skill.name, provider: opened.provider })).then(ok => ok && setOpen(null))} />
          <Muted colors={colors} small>{ui('The copy there is moved to the backups first.', '原有副本会先移到备份目录。')}</Muted>
        </View>
        : null}
    </View> : null}
  </View>;
}

function FoundItem(props: TabProps & { found: FoundSkill }) {
  const { found, colors } = props;
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{found.name}</Text>
        <Chip colors={colors} label={props.providerLabel(found.provider)} />
      </View>
      {found.description ? <Muted colors={colors} small lines={1}>{found.description}</Muted> : null}
    </View>
    <Button colors={colors} icon="Plus" label={ui('Add', '加入')} blocked={props.busy} onPress={() => void props.run(() => props.rpc(importSkill, { path: found.path, replace: false }))} />
  </View>;
}

/* ---------------------------------------------------------- Providers */

const COLUMN = 48;

function ProvidersTab(props: TabProps) {
  const { state, colors } = props;
  const columnLabel = { color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' as const };
  const providers = state.providers.filter(row => row.present);
  return <View style={{ gap: 12 }}>
    <Muted colors={colors}>{ui(
      'Choose which providers get the shared servers and skills.',
      '选择哪些 Provider 使用共享的服务器和技能。',
    )}</Muted>
    {providers.length === 0
      ? <Empty colors={colors} icon="Boxes" title={ui('No providers yet', '暂无 Provider')} hint={ui('They appear here once Paseo lists them.', 'Paseo 列出后会显示在这里。')} />
      : <List colors={colors}>
        <View key="header" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8 }}>
          <Text style={[columnLabel, { flex: 1 }]}>{ui('Provider · skills folder', 'Provider · 技能目录')}</Text>
          <Text style={[columnLabel, { width: COLUMN, textAlign: 'center' }]}>MCP</Text>
          <Text style={[columnLabel, { width: COLUMN, textAlign: 'center' }]}>{ui('Skills', '技能')}</Text>
        </View>
        {providers.map(row => <ProviderItem key={row.id} {...props} row={row} />)}
      </List>}
  </View>;
}

function ProviderItem(props: TabProps & { row: ProviderRow }) {
  const { row, colors } = props;
  const [editing, setEditing] = useState(false);
  const [dir, setDir] = useState(row.skillsDir ?? '');
  /** The switch answers on the press itself; the round trip then brings the same value back. */
  const [flipped, setFlipped] = useState<{ mcp?: boolean; skills?: boolean }>({});
  const mcp = flipped.mcp ?? row.mcp;
  const skills = flipped.skills ?? row.skills;
  const update = (patch: { mcp?: boolean; skills?: boolean; skillsDir?: string }) => props.run(() => props.rpc(updateProvider, { provider: row.id, ...patch }));
  const flip = (key: 'mcp' | 'skills', value: boolean) => {
    const clear = () => setFlipped(current => key === 'mcp' ? { ...current, mcp: undefined } : { ...current, skills: undefined });
    setFlipped(current => key === 'mcp' ? { ...current, mcp: value } : { ...current, skills: value });
    void update(key === 'mcp' ? { mcp: value } : { skills: value }).then(clear);
  };
  const startEditing = () => { setDir(row.skillsDir ?? ''); setEditing(true); };
  return <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{row.label}</Text>
          {row.skillsDirCustom ? <Chip colors={colors} label={ui('custom folder', '自定义目录')} /> : null}
        </View>
        {editing ? null : <Pressable accessibilityRole="button" accessibilityLabel={ui('Change skills folder', '修改技能目录')} onPress={startEditing}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', maxWidth: '100%' }}>
          <Text numberOfLines={1} style={{ color: row.skillsDir ? colors.foregroundMuted : colors.statusWarning, fontSize: 11, fontFamily: row.skillsDir ? MONO : undefined, flexShrink: 1 }}>
            {row.skillsDir ?? ui('Skills folder unknown; set one to share skills', '技能目录未知，设置后才能共享技能')}
          </Text>
          <Icon name="Pencil" size={11} color={colors.foregroundMuted} />
        </Pressable>}
      </View>
      <View style={{ width: COLUMN, alignItems: 'center' }}>
        <Switch colors={colors} label={`${row.label} MCP`} value={mcp} blocked={props.busy} onChange={value => flip('mcp', value)} />
      </View>
      <View style={{ width: COLUMN, alignItems: 'center' }}>
        <Switch colors={colors} label={`${row.label} ${ui('skills', '技能')}`} value={skills} disabled={!row.skillsDir} blocked={props.busy} onChange={value => flip('skills', value)} />
      </View>
    </View>
    {row.mcpNote && !mcp ? <Muted colors={colors} small>{row.mcpNote}</Muted> : null}
    {editing ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <View style={{ flex: 1, minWidth: 200 }}>
        <Field colors={colors} value={dir} onChange={setDir} onSubmit={() => { if (dir.trim()) void update({ skillsDir: dir }).then(ok => ok && setEditing(false)); }} placeholder="~/.my-cli/skills" mono />
      </View>
      {row.skillsDirCustom ? <Button colors={colors} variant="ghost" label={ui('Use default', '恢复默认')} blocked={props.busy} onPress={() => void update({ skillsDir: '' }).then(ok => ok && setEditing(false))} /> : null}
      <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setEditing(false)} />
      <Button colors={colors} variant="primary" label={ui('Save', '保存')} disabled={!dir.trim()} blocked={props.busy} onPress={() => void update({ skillsDir: dir }).then(ok => ok && setEditing(false))} />
    </View> : null}
  </View>;
}
