import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, ScrollView, useToast } from '@getpaseo/plugin/client/react-native';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { blankDraft, draftFrom, matchesQuery, serverFromDraft, summarize, type ServerDraft } from '../shared/form';
import { ui } from '../shared/i18n';
import {
  deleteMcpServer, deleteSkill, importMcpServers, importSkill, overwriteSkill, readState, saveMcpServer, syncSkills, updateProvider,
  type FoundSkill, type McpServer, type ProviderRow, type SharedState, type SkillRow, type TargetStatus,
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
            `One set of MCP servers and skills for every provider on ${props.host.label}.`,
            `${props.host.label} 上所有 Provider 共用一套 MCP 服务器和技能。`,
          )}</Muted>
        </View>
        <Button colors={colors} icon="RefreshCw" label={ui('Sync now', '立即同步')} iconOnly={compact} disabled={busy} onPress={() => void run(() => props.rpc(syncSkills, {}))} />
      </View>
      {state ? <Tabs<Tab> colors={colors} value={tab} onChange={setTab} items={[
        { id: 'mcp', label: ui('MCP servers', 'MCP 服务器'), count: state.mcpServers.length },
        { id: 'skills', label: ui('Skills', '技能'), count: state.skills.length, alert: state.notes.length > 0 || state.skills.some(skill => skill.targets.some(needsLook)) },
        { id: 'providers', label: 'Provider', count: state.providers.length },
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
      <Button colors={colors} icon="Download" label={ui('Import', '导入')} active={importing} disabled={props.busy} onPress={() => setImporting(value => !value)} />
      <Button colors={colors} icon="Plus" variant="primary" label={ui('Add server', '添加服务器')} disabled={props.busy} onPress={() => setEditing('')} />
    </View>

    {importing ? <Card colors={colors}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: '600', marginRight: 4 }}>{ui('Import from', '导入自')}</Text>
        <Button colors={colors} label="Claude Code" disabled={props.busy} onPress={() => void doImport('claude')} />
        <Button colors={colors} label="Codex" disabled={props.busy} onPress={() => void doImport('codex')} />
        <Button colors={colors} icon="ClipboardPaste" label={ui('Paste JSON', '粘贴 JSON')} active={pasting} onPress={() => setPasting(value => !value)} />
        <View style={{ flex: 1 }} />
        <Button colors={colors} variant="ghost" iconOnly icon="X" label={ui('Close', '关闭')} onPress={() => { setImporting(false); setPasting(false); }} />
      </View>
      {pasting ? <>
        <Field colors={colors} label={ui('An "mcpServers" object, as in Claude Code, Cursor or Gemini settings', '“mcpServers” 对象，格式同 Claude Code、Cursor 或 Gemini 的配置')} value={json} onChange={setJson} multiline mono
          placeholder={'{ "mcpServers": { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } } }'} />
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Button colors={colors} variant="primary" label={ui('Import', '导入')} disabled={props.busy || !json.trim()} onPress={() => void doImport('json')} />
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
  const save = (patch: Partial<McpServer>) => props.run(() => props.rpc(saveMcpServer, { ...server, ...patch, previousName: server.name }));
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11 }}>
    <View style={{ flex: 1, minWidth: 0, gap: 3, opacity: server.enabled ? 1 : 0.55 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{server.name}</Text>
        <Chip colors={colors} label={server.config.type} />
        {server.providers ? <Chip colors={colors} label={`${ui('Only', '仅')} ${server.providers.map(props.providerLabel).join(', ')}`} /> : null}
      </View>
      <Muted colors={colors} mono lines={1} selectable>{summarize(server.config)}</Muted>
    </View>
    {confirming
      ? <>
        <Button colors={colors} variant="danger" label={ui('Delete', '删除')} disabled={props.busy} onPress={() => void props.run(() => props.rpc(deleteMcpServer, { name: server.name }))} />
        <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setConfirming(false)} />
      </>
      : <>
        <Button colors={colors} variant="ghost" iconOnly icon="Pencil" label={ui('Edit', '编辑')} disabled={props.busy} onPress={props.onEdit} />
        <Button colors={colors} variant="ghost" iconOnly icon="Trash2" label={ui('Delete', '删除')} disabled={props.busy} onPress={() => setConfirming(true)} />
      </>}
    <Switch colors={colors} label={`${server.name} ${ui('on', '开启')}`} value={server.enabled} disabled={props.busy} onChange={enabled => void save({ enabled })} />
  </View>;
}

function ServerForm(props: TabProps & { draft: ServerDraft; previousName: string | null; onClose(): void }) {
  const { colors, state } = props;
  const [draft, setDraft] = useState(props.draft);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<ServerDraft>) => setDraft(current => ({ ...current, ...patch }));
  const toggleProvider = (id: string) => {
    const current = draft.providers ?? [];
    const next = current.includes(id) ? current.filter(p => p !== id) : [...current, id];
    set({ providers: next.length ? next : null });
  };
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
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' }}>{ui('Providers · none selected means every one with MCP on', 'Provider · 不选即所有开启 MCP 的')}</Text>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {state.providers.map(row => <Chip key={row.id} colors={colors} label={row.label} selected={draft.providers?.includes(row.id) ?? false} onPress={() => toggleProvider(row.id)} />)}
      </View>
    </View>
    {problem ? <Muted colors={colors} danger>{problem}</Muted> : null}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
      <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={props.onClose} />
      <Button colors={colors} variant="primary" label={ui('Save', '保存')} disabled={props.busy} onPress={submit} />
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
      <Button colors={colors} icon="FolderPlus" label={ui('Add folder', '添加文件夹')} active={adding} disabled={props.busy} onPress={() => setAdding(value => !value)} />
    </View>

    {adding ? <Card colors={colors}>
      <Field colors={colors} label={ui('A skill folder with a SKILL.md, from anywhere', '含 SKILL.md 的技能文件夹，可在任意位置')} value={path} onChange={setPath} onSubmit={addPath} placeholder="~/Downloads/my-skill" mono />
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
        <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setAdding(false)} />
        <Button colors={colors} variant="primary" label={ui('Add to library', '加入技能库')} disabled={props.busy || !path.trim()} onPress={addPath} />
      </View>
    </Card> : null}

    {filtered && skills.length + found.length === 0
      ? <Empty colors={colors} icon="SearchX" title={ui(`No skills match “${query.trim()}”`, `没有匹配“${query.trim()}”的技能`)} />
      : <>
        {!filtered || skills.length ? <View style={{ gap: 8 }}>
          <Heading colors={colors} title={ui('Library', '技能库')} count={count(skills.length, state.skills.length)}
            hint={ui('Copied into every provider with skills on. Copies edited there are never overwritten without asking.', '复制到每个开启技能的 Provider；在 Provider 里改过的副本不会被直接覆盖。')} />
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
  const [open, setOpen] = useState<string | null>(null);
  const synced = skill.targets.filter(target => !needsLook(target));
  const issues = skill.targets.filter(needsLook);
  const opened = issues.find(target => target.provider === open);
  return <View style={{ paddingHorizontal: 14, paddingVertical: 11, gap: 7 }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{skill.name}</Text>
        {skill.description ? <Muted colors={colors} small lines={2}>{skill.description}</Muted> : null}
      </View>
      {confirming
        ? <>
          <Button colors={colors} variant="danger" label={ui('Remove everywhere', '从所有位置移除')} disabled={props.busy} onPress={() => void props.run(() => props.rpc(deleteSkill, { name: skill.name }))} />
          <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setConfirming(false)} />
        </>
        : <Button colors={colors} variant="ghost" iconOnly icon="Trash2" label={ui('Remove', '移除')} disabled={props.busy} onPress={() => setConfirming(true)} />}
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
      {skill.targets.length === 0 ? <Muted colors={colors} small>{ui('No provider has skills on.', '没有开启技能的 Provider。')}</Muted> : null}
    </View>
    {confirming ? <Muted colors={colors} small>{ui('Moves the library copy to the backups and removes the untouched copies from every provider.', '把技能库中的副本移到备份目录，并从各 Provider 删除未改动的副本。')}</Muted> : null}
    {opened ? <View style={{ gap: 8, padding: 10, borderRadius: 8, backgroundColor: colors.surface2 }}>
      {opened.message ? <Muted colors={colors} selectable danger={opened.status === 'error'}>{opened.message}</Muted> : null}
      {opened.status === 'modified' || opened.status === 'conflict'
        ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Button colors={colors} icon="Replace" label={ui(`Replace ${props.providerLabel(opened.provider)}'s copy`, `替换 ${props.providerLabel(opened.provider)} 的副本`)} disabled={props.busy}
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
    <Button colors={colors} icon="Plus" label={ui('Add', '加入')} disabled={props.busy} onPress={() => void props.run(() => props.rpc(importSkill, { path: found.path, replace: false }))} />
  </View>;
}

/* ---------------------------------------------------------- Providers */

const COLUMN = 48;

function ProvidersTab(props: TabProps) {
  const { state, colors } = props;
  const columnLabel = { color: colors.foregroundMuted, fontSize: 11, fontWeight: '600' as const };
  return <View style={{ gap: 12 }}>
    <Muted colors={colors}>{ui(
      'Choose which providers get the shared servers and skills. Providers disabled in Paseo keep their choices.',
      '选择哪些 Provider 使用共享的服务器和技能。在 Paseo 中停用的 Provider 会保留设置。',
    )}</Muted>
    {state.providers.length === 0
      ? <Empty colors={colors} icon="Boxes" title={ui('No providers yet', '暂无 Provider')} hint={ui('They appear here once Paseo lists them.', 'Paseo 列出后会显示在这里。')} />
      : <List colors={colors}>
        <View key="header" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8 }}>
          <Text style={[columnLabel, { flex: 1 }]}>{ui('Provider · skills folder', 'Provider · 技能目录')}</Text>
          <Text style={[columnLabel, { width: COLUMN, textAlign: 'center' }]}>MCP</Text>
          <Text style={[columnLabel, { width: COLUMN, textAlign: 'center' }]}>{ui('Skills', '技能')}</Text>
        </View>
        {state.providers.map(row => <ProviderItem key={row.id} {...props} row={row} />)}
      </List>}
  </View>;
}

function ProviderItem(props: TabProps & { row: ProviderRow }) {
  const { row, colors } = props;
  const [editing, setEditing] = useState(false);
  const [dir, setDir] = useState(row.skillsDir ?? '');
  const update = (patch: { mcp?: boolean; skills?: boolean; skillsDir?: string }) => props.run(() => props.rpc(updateProvider, { provider: row.id, ...patch }));
  const startEditing = () => { setDir(row.skillsDir ?? ''); setEditing(true); };
  return <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8, opacity: row.present ? 1 : 0.7 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: '600', flexShrink: 1 }}>{row.label}</Text>
          {!row.present ? <Chip colors={colors} label={ui('not enabled in Paseo', '未在 Paseo 启用')} /> : null}
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
        <Switch colors={colors} label={`${row.label} MCP`} value={row.mcp} disabled={props.busy} onChange={mcp => void update({ mcp })} />
      </View>
      <View style={{ width: COLUMN, alignItems: 'center' }}>
        <Switch colors={colors} label={`${row.label} ${ui('skills', '技能')}`} value={row.skills} disabled={props.busy || !row.skillsDir} onChange={skills => void update({ skills })} />
      </View>
    </View>
    {row.mcpNote && !row.mcp ? <Muted colors={colors} small>{row.mcpNote}</Muted> : null}
    {editing ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <View style={{ flex: 1, minWidth: 200 }}>
        <Field colors={colors} value={dir} onChange={setDir} onSubmit={() => { if (dir.trim()) void update({ skillsDir: dir }).then(ok => ok && setEditing(false)); }} placeholder="~/.my-cli/skills" mono />
      </View>
      {row.skillsDirCustom ? <Button colors={colors} variant="ghost" label={ui('Use default', '恢复默认')} disabled={props.busy} onPress={() => void update({ skillsDir: '' }).then(ok => ok && setEditing(false))} /> : null}
      <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setEditing(false)} />
      <Button colors={colors} variant="primary" label={ui('Save', '保存')} disabled={props.busy || !dir.trim()} onPress={() => void update({ skillsDir: dir }).then(ok => ok && setEditing(false))} />
    </View> : null}
  </View>;
}
