import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { ScrollView } from '@getpaseo/plugin/client/react-native';
import { ActivityIndicator, Text, View } from 'react-native';
import { blankDraft, draftFrom, serverFromDraft, summarize, type ServerDraft } from '../shared/form';
import { ui } from '../shared/i18n';
import {
  deleteMcpServer, deleteSkill, importMcpServers, importSkill, overwriteSkill, readState, saveMcpServer, syncSkills, updateProvider,
  type McpServer, type ProviderRow, type SharedState, type SkillRow, type TargetStatus,
} from '../shared/rpc';
import { Button, Card, Chip, Field, Muted, Section, Toggle, type Colors } from './kit';

type Rpc = PluginClientContext['rpc'];

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

export function SharedToolsPage(props: PluginSurfaceProps & { rpc: Rpc }) {
  const { colors } = props.theme;
  const [state, setState] = useState<SharedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  return <ScrollView contentContainerStyle={{ padding: 20, gap: 24 }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: '700' }}>{ui('Shared MCP & skills', '共享 MCP 与技能')}</Text>
        <Muted colors={colors}>{ui(
          `One list of MCP servers and one skill library for every provider on ${props.host.label}. Servers are added to new agents as they start; skills are copied into each CLI's own skills folder.`,
          `${props.host.label} 上所有 Provider 共用一份 MCP 服务器列表和一个技能库。服务器在新 Agent 启动时加入；技能会复制到各 CLI 自己的技能目录。`,
        )}</Muted>
      </View>
      <Button colors={colors} icon="RefreshCw" label={ui('Sync now', '立即同步')} disabled={busy} onPress={() => void run(() => props.rpc(syncSkills, {}))} />
    </View>
    {error ? <Muted colors={colors} danger selectable>{error}</Muted> : null}
    {notice ? <Muted colors={colors} selectable>{notice}</Muted> : null}
    {state === null
      ? <ActivityIndicator color={colors.foregroundMuted} />
      : <>
        <ProvidersSection state={state} colors={colors} busy={busy} rpc={props.rpc} run={run} />
        <McpSection state={state} colors={colors} busy={busy} rpc={props.rpc} run={run} setNotice={setNotice} providerLabel={providerLabel} />
        <SkillsSection state={state} colors={colors} busy={busy} rpc={props.rpc} run={run} providerLabel={providerLabel} />
        {state.notes.length ? <Card colors={colors}>{state.notes.map(note => <Muted key={note} colors={colors} selectable>{note}</Muted>)}</Card> : null}
        <Muted colors={colors} selectable>{ui('Data folder', '数据目录')}: {state.dataDir}{state.syncedAt ? ` · ${ui('last synced', '上次同步')} ${new Date(state.syncedAt).toLocaleString()}` : ''}</Muted>
      </>}
  </ScrollView>;
}

interface SectionProps {
  state: SharedState;
  colors: Colors;
  busy: boolean;
  rpc: Rpc;
  run(job: () => Promise<SharedState | null>): Promise<boolean>;
}

function ProvidersSection(props: SectionProps) {
  const { state, colors } = props;
  return <Section colors={colors} title={ui('Providers', 'Provider')} hint={ui(
    'Choose which providers get the shared servers and skills. Providers disabled in Paseo keep their choices and are left alone.',
    '选择哪些 Provider 使用共享的服务器和技能。在 Paseo 中停用的 Provider 会保留设置，不会被改动。',
  )}>
    {state.providers.length === 0
      ? <Muted colors={colors}>{ui('No providers yet. They appear here once Paseo lists them.', '暂无 Provider，Paseo 列出后会显示在这里。')}</Muted>
      : state.providers.map(row => <ProviderCard key={row.id} {...props} row={row} />)}
  </Section>;
}

function ProviderCard(props: SectionProps & { row: ProviderRow }) {
  const { row, colors } = props;
  const [editing, setEditing] = useState(false);
  const [dir, setDir] = useState(row.skillsDir ?? '');
  const update = (patch: { mcp?: boolean; skills?: boolean; skillsDir?: string }) => props.run(() => props.rpc(updateProvider, { provider: row.id, ...patch }));
  return <Card colors={colors}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '600', flex: 1, minWidth: 120 }}>{row.label}</Text>
      {!row.present ? <Chip colors={colors} label={ui('not enabled in Paseo', '未在 Paseo 启用')} /> : null}
      <Toggle colors={colors} label="MCP" value={row.mcp} disabled={props.busy} onChange={mcp => void update({ mcp })} />
      <Toggle colors={colors} label={ui('Skills', '技能')} value={row.skills} disabled={props.busy || !row.skillsDir} onChange={skills => void update({ skills })} />
    </View>
    {row.mcpNote && !row.mcp ? <Muted colors={colors}>{row.mcpNote}</Muted> : null}
    {editing
      ? <View style={{ gap: 6 }}>
        <Field colors={colors} label={ui('Skills folder', '技能目录')} value={dir} onChange={setDir} placeholder="~/.my-cli/skills" mono />
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Button colors={colors} variant="primary" label={ui('Save', '保存')} disabled={props.busy || !dir.trim()} onPress={() => void update({ skillsDir: dir }).then(ok => ok && setEditing(false))} />
          {row.skillsDirCustom ? <Button colors={colors} label={ui('Use default', '恢复默认')} disabled={props.busy} onPress={() => void update({ skillsDir: '' }).then(ok => ok && setEditing(false))} /> : null}
          <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => { setDir(row.skillsDir ?? ''); setEditing(false); }} />
        </View>
      </View>
      : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Muted colors={colors} selectable>{row.skillsDir
            ? `${row.skillsDir}${row.skillsDirCustom ? ` (${ui('custom', '自定义')})` : ''}`
            : ui('Skills folder unknown for this CLI; set one to share skills with it.', '不知道这个 CLI 的技能目录，设置后才能共享技能。')}</Muted>
        </View>
        <Button colors={colors} variant="ghost" icon="FolderPen" label={ui('Change', '修改')} onPress={() => { setDir(row.skillsDir ?? ''); setEditing(true); }} />
      </View>}
  </Card>;
}

function McpSection(props: SectionProps & { setNotice(notice: string | null): void; providerLabel(id: string): string }) {
  const { state, colors } = props;
  const [draft, setDraft] = useState<{ draft: ServerDraft; previousName: string | null } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [json, setJson] = useState('');

  const doImport = (source: 'claude' | 'codex' | 'json') => props.run(async () => {
    const result = await props.rpc(importMcpServers, { source, ...(source === 'json' ? { json } : {}), replace: false });
    props.setNotice([
      result.imported.length ? `${ui('Imported', '已导入')}: ${result.imported.join(', ')}` : ui('Nothing new to import.', '没有可导入的新服务器。'),
      ...result.skipped.map(line => `${ui('Skipped', '已跳过')} ${line}`),
    ].join('\n'));
    if (source === 'json' && result.imported.length) { setJson(''); setPasting(false); }
    return result.state;
  });

  return <Section colors={colors} title={ui('MCP servers', 'MCP 服务器')} hint={ui(
    'Added to every new agent of a provider with MCP on, next to Paseo\'s own tools. Agents already running keep what they started with. A server an agent is created with by name is never replaced.',
    '会加入每个开启了 MCP 的 Provider 新建的 Agent，与 Paseo 自带工具并列。已运行的 Agent 保持启动时的配置。创建 Agent 时已指定的同名服务器不会被替换。',
  )} actions={<>
    <Button colors={colors} icon="Plus" variant="primary" label={ui('Add', '添加')} disabled={props.busy} onPress={() => setDraft({ draft: blankDraft(), previousName: null })} />
    <Button colors={colors} icon="Download" label={ui('From Claude Code', '从 Claude Code')} disabled={props.busy} onPress={() => void doImport('claude')} />
    <Button colors={colors} icon="Download" label={ui('From Codex', '从 Codex')} disabled={props.busy} onPress={() => void doImport('codex')} />
    <Button colors={colors} icon="ClipboardPaste" label={ui('Paste JSON', '粘贴 JSON')} disabled={props.busy} onPress={() => setPasting(value => !value)} />
  </>}>
    {pasting ? <Card colors={colors}>
      <Field colors={colors} label={ui('An "mcpServers" object, as in Claude Code, Cursor or Gemini settings', '“mcpServers” 对象，格式同 Claude Code、Cursor 或 Gemini 的配置')} value={json} onChange={setJson} multiline mono
        placeholder={'{ "mcpServers": { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } } }'} />
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Button colors={colors} variant="primary" label={ui('Import', '导入')} disabled={props.busy || !json.trim()} onPress={() => void doImport('json')} />
        <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={() => setPasting(false)} />
      </View>
    </Card> : null}
    {draft ? <ServerForm {...props} draft={draft.draft} previousName={draft.previousName} onClose={() => setDraft(null)} /> : null}
    {state.mcpServers.length === 0 && !draft
      ? <Muted colors={colors}>{ui('No shared servers yet.', '还没有共享的服务器。')}</Muted>
      : state.mcpServers.map(server => <ServerCard key={server.name} {...props} server={server} onEdit={() => setDraft({ draft: draftFrom(server), previousName: server.name })} />)}
  </Section>;
}

function ServerCard(props: SectionProps & { server: McpServer; onEdit(): void; providerLabel(id: string): string }) {
  const { server, colors } = props;
  const [confirming, setConfirming] = useState(false);
  const save = (patch: Partial<McpServer>) => props.run(() => props.rpc(saveMcpServer, { ...server, ...patch, previousName: server.name }));
  return <Card colors={colors}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '600' }}>{server.name}</Text>
      <Chip colors={colors} label={server.config.type} />
      <View style={{ flex: 1 }} />
      <Toggle colors={colors} label={server.enabled ? ui('On', '开') : ui('Off', '关')} value={server.enabled} disabled={props.busy} onChange={enabled => void save({ enabled })} />
      <Button colors={colors} variant="ghost" icon="Pencil" label={ui('Edit', '编辑')} disabled={props.busy} onPress={props.onEdit} />
      {confirming
        ? <Button colors={colors} variant="danger" label={ui('Confirm delete', '确认删除')} disabled={props.busy} onPress={() => void props.run(() => props.rpc(deleteMcpServer, { name: server.name }))} />
        : <Button colors={colors} variant="ghost" icon="Trash2" label={ui('Delete', '删除')} disabled={props.busy} onPress={() => setConfirming(true)} />}
    </View>
    <Text selectable numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 11, fontFamily: 'monospace' }}>{summarize(server.config)}</Text>
    <Muted colors={colors}>{server.providers
      ? `${ui('Only for', '仅用于')} ${server.providers.map(props.providerLabel).join(', ')}`
      : ui('For every provider with MCP on', '用于所有开启 MCP 的 Provider')}</Muted>
  </Card>;
}

function ServerForm(props: SectionProps & { draft: ServerDraft; previousName: string | null; onClose(): void }) {
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
  return <Card colors={colors}>
    <Field colors={colors} label={ui('Name', '名称')} value={draft.name} onChange={name => set({ name })} placeholder="context7" />
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {(['stdio', 'http', 'sse'] as const).map(type => <Chip key={type} colors={colors} label={type} selected={draft.type === type} onPress={() => set({ type })} />)}
    </View>
    {draft.type === 'stdio'
      ? <>
        <Field colors={colors} label={ui('Command', '命令')} value={draft.command} onChange={command => set({ command })} placeholder="npx" mono />
        <Field colors={colors} label={ui('Arguments, one per line', '参数，每行一个')} value={draft.args} onChange={args => set({ args })} multiline mono placeholder={'-y\n@upstash/context7-mcp'} />
        <Field colors={colors} label={ui('Environment, KEY=value per line', '环境变量，每行 KEY=value')} value={draft.env} onChange={env => set({ env })} multiline mono />
      </>
      : <>
        <Field colors={colors} label="URL" value={draft.url} onChange={url => set({ url })} placeholder="https://example.com/mcp" mono />
        <Field colors={colors} label={ui('Headers, Name: value per line', '请求头，每行 Name: value')} value={draft.headers} onChange={headers => set({ headers })} multiline mono placeholder="Authorization: Bearer …" />
      </>}
    <View style={{ gap: 4 }}>
      <Muted colors={colors}>{ui('Providers (none selected means all with MCP on)', 'Provider（不选表示所有开启 MCP 的）')}</Muted>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {state.providers.map(row => <Chip key={row.id} colors={colors} label={row.label} selected={draft.providers?.includes(row.id) ?? false} onPress={() => toggleProvider(row.id)} />)}
      </View>
    </View>
    {problem ? <Muted colors={colors} danger>{problem}</Muted> : null}
    <View style={{ flexDirection: 'row', gap: 6 }}>
      <Button colors={colors} variant="primary" label={ui('Save', '保存')} disabled={props.busy} onPress={submit} />
      <Button colors={colors} variant="ghost" label={ui('Cancel', '取消')} onPress={props.onClose} />
    </View>
  </Card>;
}

function SkillsSection(props: SectionProps & { providerLabel(id: string): string }) {
  const { state, colors } = props;
  const [path, setPath] = useState('');
  return <Section colors={colors} title={ui('Skills', '技能')} hint={ui(
    `The library is ${state.libraryDir}. Each skill there is copied into every provider with skills on, and edits to the library follow within seconds. Copies edited in a provider's folder, and skills of your own with the same name, are never overwritten without asking.`,
    `技能库位于 ${state.libraryDir}。其中每个技能会复制到所有开启技能的 Provider，库里的修改几秒内同步过去。在 Provider 目录里改过的副本，以及你自己的同名技能，不经确认不会被覆盖。`,
  )}>
    {state.skills.length === 0
      ? <Muted colors={colors}>{ui('The library is empty. Import skills your providers already have below, or add a folder with a SKILL.md to the library.', '技能库是空的。可以在下方导入各 Provider 已有的技能，或把含 SKILL.md 的文件夹放进技能库。')}</Muted>
      : state.skills.map(skill => <SkillCard key={skill.name} {...props} skill={skill} />)}
    {state.found.length ? <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{ui('Found in provider folders', '在 Provider 目录中发现')}</Text>
      {state.found.map(found => <Card key={found.path} colors={colors}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: '600' }}>{found.name}</Text>
          <Chip colors={colors} label={props.providerLabel(found.provider)} />
          <View style={{ flex: 1 }} />
          <Button colors={colors} icon="Download" label={ui('Add to library', '加入技能库')} disabled={props.busy} onPress={() => void props.run(() => props.rpc(importSkill, { path: found.path, replace: false }))} />
        </View>
        {found.description ? <Muted colors={colors}>{found.description}</Muted> : null}
      </Card>)}
    </View> : null}
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
      <View style={{ flex: 1 }}>
        <Field colors={colors} label={ui('Add a skill folder from anywhere', '从任意位置添加技能文件夹')} value={path} onChange={setPath} placeholder="~/Downloads/my-skill" mono />
      </View>
      <Button colors={colors} label={ui('Add', '添加')} disabled={props.busy || !path.trim()} onPress={() => void props.run(() => props.rpc(importSkill, { path, replace: false })).then(ok => ok && setPath(''))} />
    </View>
  </Section>;
}

function SkillCard(props: SectionProps & { skill: SkillRow; providerLabel(id: string): string }) {
  const { skill, colors } = props;
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const opened = skill.targets.find(target => target.provider === open);
  return <Card colors={colors}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '600', flex: 1 }}>{skill.name}</Text>
      {confirming
        ? <Button colors={colors} variant="danger" label={ui('Remove everywhere', '从所有位置移除')} disabled={props.busy} onPress={() => void props.run(() => props.rpc(deleteSkill, { name: skill.name }))} />
        : <Button colors={colors} variant="ghost" icon="Trash2" label={ui('Remove', '移除')} disabled={props.busy} onPress={() => setConfirming(true)} />}
    </View>
    {skill.description ? <Muted colors={colors}>{skill.description}</Muted> : null}
    <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
      {skill.targets.map(target => <Chip key={target.provider} colors={colors} tone={statusTones[target.status]}
        label={`${props.providerLabel(target.provider)} · ${statusLabels[target.status]}`}
        onPress={target.message || target.status !== 'synced' ? () => setOpen(current => current === target.provider ? null : target.provider) : undefined} />)}
    </View>
    {confirming ? <Muted colors={colors}>{ui('Moves the library copy to the backups and removes the untouched copies from every provider.', '把技能库中的副本移到备份目录，并从各 Provider 删除未改动的副本。')}</Muted> : null}
    {opened ? <View style={{ gap: 6 }}>
      {opened.message ? <Muted colors={colors} selectable danger={opened.status === 'error'}>{opened.message}</Muted> : null}
      {opened.status === 'modified' || opened.status === 'conflict'
        ? <View style={{ flexDirection: 'row' }}>
          <Button colors={colors} icon="Replace" label={ui(`Replace ${props.providerLabel(opened.provider)}'s copy`, `替换 ${props.providerLabel(opened.provider)} 的副本`)} disabled={props.busy}
            onPress={() => void props.run(() => props.rpc(overwriteSkill, { name: skill.name, provider: opened.provider })).then(ok => ok && setOpen(null))} />
        </View>
        : null}
      {opened.status === 'modified' || opened.status === 'conflict'
        ? <Muted colors={colors}>{ui('The copy there is moved to the backups first.', '原有副本会先移到备份目录。')}</Muted>
        : null}
    </View> : null}
  </Card>;
}
