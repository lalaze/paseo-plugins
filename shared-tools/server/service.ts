import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import { nameSchema, providerAccessSchema, type FoundSkill, type McpConfig, type McpServer, type ProviderAccess, type ProviderRow, type SharedState, type SkillRow } from '../shared/rpc';
import type { GatewayConfig, GatewayState } from '../shared/gateway';
import { allowsProvider } from '../shared/access';
import { normalizeServer, parseServerJson, readClaudeServers, readCodexServers, RESERVED_SERVERS, serversFor, stripStored, type Parsed, type StoredServer } from './mcp';
import { Gateway } from './gateway';
import { REDIRECT_URI, SignIns, type FlowStatus } from './oauth';
import { CodexSignIns, type StartedSignIn } from './codex-sign-in';
import { expandHome, knownSkillsDir, mcpDefault } from './providers';
import { importSkillDir, readLibrary, removeFromLibrary, syncTarget, type LibrarySkill, type Placement } from './skills';

interface ProviderPrefs {
  label?: string;
  /** The executable a custom provider runs, used to find its CLI's skills folder. */
  command?: string | null;
  present?: boolean;
  mcp?: boolean;
  skills?: boolean;
  skillsDir?: string;
}

/** config.json. `mcpServers` is kept as written, so a hand-edited entry the plugin cannot read is skipped, never dropped. */
interface Stored {
  version: 1;
  mcpServers: Record<string, unknown>;
  providers: Record<string, ProviderPrefs>;
  skillAccess: Record<string, unknown>;
}

interface Report { skills: SkillRow[]; found: FoundSkill[]; notes: string[]; syncedAt: string }

type Providers = Pick<PaseoApi['providers'], 'snapshot'>;
type Config = Pick<PaseoApi['config'], 'get'>;
export type Paseo = { providers: Providers; config: Config };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const WATCH_DEBOUNCE_MS = 1500;

export class SharedTools {
  readonly libraryDir: string;
  readonly backupDir: string;
  private readonly configPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private report: Report | null = null;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  readonly signIns: SignIns;
  readonly gateway: Gateway;
  private readonly codexSignIns: CodexSignIns;

  constructor(readonly root: string, private readonly home = homedir(), private readonly log: (error: unknown) => void = () => undefined, signIns?: SignIns, codexSignIns?: CodexSignIns) {
    this.signIns = signIns ?? new SignIns(root, log, fetch, true, home);
    this.codexSignIns = codexSignIns ?? new CodexSignIns(home, async (name, config) => {
      if (await this.signIns.reuse(name, config, 'codex') !== 'Codex') throw new Error('No reusable Codex MCP credential.');
    });
    this.libraryDir = join(root, 'skills');
    this.backupDir = join(root, 'backups');
    this.configPath = join(root, 'config.json');
    // The gateway keeps its own file and only reads the shared config through these callbacks.
    this.gateway = new Gateway(root, {
      servers: async () => this.servers(await this.load()).valid,
      providerMcpOn: async provider => this.row(provider, (await this.load()).providers[provider] ?? {}).mcp,
      authHeader: (name, config) => this.signIns.header(name, config),
    }, log);
  }

  /** Every read-modify-write and every sync runs one at a time. */
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<Stored> {
    const text = await readFile(this.configPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (text === null) return { version: 1, mcpServers: {}, providers: {}, skillAccess: {} };
    let parsed: Record<string, unknown> | null;
    try { parsed = record(JSON.parse(text)); }
    catch { throw new Error(`${this.configPath} is not valid JSON; fix or remove it.`); }
    return {
      version: 1,
      mcpServers: record(parsed?.mcpServers) ?? {},
      providers: (record(parsed?.providers) ?? {}) as Record<string, ProviderPrefs>,
      skillAccess: record(parsed?.skillAccess) ?? {},
    };
  }

  private async save(stored: Stored): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    // Headers and env values can hold tokens.
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.configPath);
  }

  private servers(stored: Stored): { valid: Record<string, StoredServer>; notes: string[] } {
    const valid: Record<string, StoredServer> = {};
    const notes: string[] = [];
    for (const [name, raw] of Object.entries(stored.mcpServers)) {
      if (!nameSchema.safeParse(name).success || RESERVED_SERVERS.has(name)) { notes.push(`MCP server "${name}" is skipped: ${RESERVED_SERVERS.has(name) ? 'Paseo reserves that name' : 'invalid name'}.`); continue; }
      try {
        const entry = record(raw) ?? {};
        const access = providerAccessSchema.parse({ ...entry, providers: entry.providers ?? null });
        valid[name] = { ...normalizeServer(entry), ...(entry.enabled === false ? { enabled: false } : {}), ...(access.providers !== null ? { providers: access.providers } : {}), ...(access.excludedProviders ? { excludedProviders: access.excludedProviders } : {}) };
      } catch (error) {
        notes.push(`MCP server "${name}" is skipped: ${message(error)}`);
      }
    }
    return { valid, notes };
  }

  private row(id: string, prefs: ProviderPrefs): ProviderRow {
    const fallback = mcpDefault(id);
    const known = knownSkillsDir(id, prefs.command ?? null, this.home);
    const custom = prefs.skillsDir ? expandHome(prefs.skillsDir, this.home) : null;
    const skillsDir = custom ?? known;
    return {
      id,
      label: prefs.label ?? id,
      present: prefs.present ?? false,
      mcp: prefs.mcp ?? fallback.on,
      mcpNote: fallback.note,
      skills: (prefs.skills ?? true) && skillsDir !== null,
      skillsDir,
      skillsDirCustom: custom !== null,
    };
  }

  private rows(stored: Stored): ProviderRow[] {
    return Object.entries(stored.providers)
      .map(([id, prefs]) => this.row(id, prefs))
      .sort((a, b) => Number(b.present) - Number(a.present) || a.label.localeCompare(b.label));
  }

  /** Records which providers Paseo has enabled now, with their labels and commands. */
  private async refreshProviders(stored: Stored, paseo: Paseo): Promise<boolean> {
    const snapshot = await paseo.providers.snapshot();
    const commands: Record<string, string | null> = {};
    try {
      const { config } = await paseo.config.get();
      for (const [id, entry] of Object.entries(config.providers ?? {})) {
        const command = (entry as { command?: unknown }).command;
        const first = Array.isArray(command) ? command[0] : command;
        commands[id] = typeof first === 'string' ? first : null;
      }
    } catch (error) {
      this.log(error);
    }
    const enabled = new Map(snapshot.entries.filter(entry => entry.enabled).map(entry => [entry.provider, entry.label]));
    let changed = false;
    for (const id of new Set([...Object.keys(stored.providers), ...enabled.keys()])) {
      const before = stored.providers[id] ?? {};
      const label = enabled.get(id) ?? before.label;
      const next: ProviderPrefs = { ...before, present: enabled.has(id), ...(label ? { label } : {}), ...(id in commands ? { command: commands[id] } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(before)) { stored.providers[id] = next; changed = true; }
    }
    return changed;
  }

  private async sync(stored: Stored, force?: { name: string; provider: string }): Promise<Report> {
    const library = await readLibrary(this.libraryDir);
    const policyNotes: string[] = [];
    const access = new Map(library.skills.map(skill => {
      const parsed = providerAccessSchema.safeParse(stored.skillAccess[skill.name] ?? { providers: null });
      if (!parsed.success) policyNotes.push(`Skill "${skill.name}" was not shared: invalid provider permissions in config.json.`);
      return [skill.name, parsed.success ? parsed.data : { providers: [] }] as const;
    }));
    const names = new Set(library.skills.map(skill => skill.name));
    const rows = this.rows(stored).filter(row => row.present && row.skillsDir);
    // Providers can share a folder; each folder is synced once, with every provider that uses it.
    const targets = new Map<string, { dir: string; providers: string[] }>();
    for (const row of rows) {
      const dir = await realpath(row.skillsDir!).catch(() => resolve(row.skillsDir!));
      const target = targets.get(dir) ?? { dir, providers: [] };
      target.providers.push(row.id);
      targets.set(dir, target);
    }
    const placements = new Map<string, Map<string, Placement>>();
    const found: FoundSkill[] = [];
    const notes = [...library.notes, ...policyNotes];
    for (const target of targets.values()) {
      const blocked = new Map<string, Placement>();
      const skills: readonly LibrarySkill[] = library.skills.filter(skill => {
        const allowed = target.providers.filter(id => rows.find(row => row.id === id)!.skills && allowsProvider(access.get(skill.name)!, id));
        if (allowed.length && allowed.length !== target.providers.length) {
          const message = `Skill "${skill.name}" was not shared: ${target.providers.join(', ')} use the same skills folder (${target.dir}) but have different permissions. Set separate skills folders in Providers.`;
          notes.push(message);
          blocked.set(skill.name, { status: 'error', message });
          return false;
        }
        return allowed.length > 0;
      });
      const forced = force && target.providers.includes(force.provider) ? new Set([force.name]) : undefined;
      try {
        const result = await syncTarget({ ...target, skills }, names, this.backupDir, forced);
        for (const [name, placement] of blocked) result.placements.set(name, placement);
        for (const provider of target.providers) placements.set(provider, result.placements);
        found.push(...result.found);
        notes.push(...result.notes);
      } catch (error) {
        notes.push(`${target.dir} could not be synced: ${message(error)}`);
        const failed = new Map<string, Placement>(skills.map(skill => [skill.name, { status: 'error' as const, message: message(error) }]));
        for (const [name, placement] of blocked) failed.set(name, placement);
        for (const provider of target.providers) placements.set(provider, failed);
      }
    }
    const skills: SkillRow[] = library.skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      ...access.get(skill.name)!,
      targets: rows.filter(row => row.skills && allowsProvider(access.get(skill.name)!, row.id)).map(row => {
        const placement = placements.get(row.id)?.get(skill.name);
        return { provider: row.id, status: placement?.status ?? 'error', message: placement?.message ?? (placement ? null : 'Not synced.') };
      }),
    }));
    this.report = { skills, found, notes, syncedAt: new Date().toISOString() };
    return this.report;
  }

  private snapshot(stored: Stored, report: Report): SharedState {
    const servers = this.servers(stored);
    const mcpServers: McpServer[] = Object.entries(servers.valid).map(([name, server]) => ({
      name, enabled: server.enabled !== false, providers: server.providers ?? null, excludedProviders: server.excludedProviders ?? [], config: stripStored(server),
    }));
    return {
      dataDir: this.root,
      libraryDir: this.libraryDir,
      providers: this.rows(stored),
      mcpServers: mcpServers.sort((a, b) => a.name.localeCompare(b.name)),
      auth: this.signIns.statuses(Object.fromEntries(mcpServers.map(server => [server.name, server.config]))),
      skills: report.skills,
      found: report.found,
      syncedAt: report.syncedAt,
      notes: [...servers.notes, ...report.notes],
    };
  }

  /** Loads, applies `change`, saves if it changed anything, re-syncs skills when asked, and returns the screen's state. */
  private mutate(change: (stored: Stored) => Promise<{ save: boolean; resync: boolean; force?: { name: string; provider: string } }>, paseo?: Paseo): Promise<SharedState> {
    return this.exclusive(async () => {
      const stored = await this.load();
      let { save, resync, force } = await change(stored);
      if (paseo) {
        try { if (await this.refreshProviders(stored, paseo)) { save = true; resync = true; } }
        catch (error) { this.log(error); }
      }
      if (save) await this.save(stored);
      // A permission, enablement or server change may invalidate live gateway requests and sessions.
      if (save) await this.gateway.reconcile().catch(this.log);
      await this.signIns.load().catch(this.log);
      await this.signIns.readSources().catch(this.log);
      const report = resync || !this.report ? await this.sync(stored, force) : this.report;
      return this.snapshot(stored, report);
    });
  }

  state(paseo: Paseo): Promise<SharedState> {
    // Reading also syncs: the screen should show what is on disk now, not at the last change.
    return this.mutate(async () => ({ save: false, resync: true }), paseo);
  }

  syncNow(): Promise<SharedState> {
    return this.mutate(async () => ({ save: false, resync: true }));
  }

  saveServer(input: McpServer & { previousName: string | null }): Promise<SharedState> {
    return this.mutate(async stored => {
      if (RESERVED_SERVERS.has(input.name)) throw new Error(`"${input.name}" is reserved by Paseo.`);
      if (input.name !== input.previousName && input.name in stored.mcpServers) throw new Error(`A server named "${input.name}" is already shared.`);
      if (input.previousName && input.previousName !== input.name) {
        delete stored.mcpServers[input.previousName];
        await this.signIns.rename(input.previousName, input.name);
      }
      const access = providerAccessSchema.parse(input);
      stored.mcpServers[input.name] = { ...input.config, ...(input.enabled ? {} : { enabled: false }), ...(access.providers !== null ? { providers: access.providers } : {}), ...(access.excludedProviders?.length ? { excludedProviders: access.excludedProviders } : {}) };
      return { save: true, resync: false };
    });
  }

  deleteServer(name: string): Promise<SharedState> {
    return this.mutate(async stored => {
      this.codexSignIns.cancel(name);
      delete stored.mcpServers[name];
      await this.signIns.signOut(name);
      return { save: true, resync: false };
    });
  }

  /** Signs in to a shared http or sse server; the app opens the returned URL in its own browser. */
  async startSignIn(name: string, reuseExisting = true, via?: 'codex'): Promise<StartedSignIn> {
    const server = this.servers(await this.load()).valid[name];
    if (!server) throw new Error(`No shared server is named "${name}".`);
    const config = stripStored(server);
    this.cancelSignIn(name);
    if (via === 'codex') return this.codexSignIns.start(name, config);
    const source = reuseExisting ? await this.signIns.reuse(name, config) : null;
    if (source) return { authorizationUrl: '', redirectUri: REDIRECT_URI, listening: false, reused: true, source };
    return this.signIns.start(name, stripStored(server));
  }

  finishSignIn(name: string, callback: string): Promise<SharedState> {
    return this.mutate(async () => {
      if (this.codexSignIns.status(name)) await this.codexSignIns.finish(name, callback);
      else await this.signIns.finish(name, callback);
      return { save: false, resync: false };
    });
  }

  signInStatus(name: string): FlowStatus {
    return this.codexSignIns.status(name) ?? this.signIns.status(name);
  }

  cancelSignIn(name: string): void {
    this.signIns.cancel(name);
    this.codexSignIns.cancel(name);
  }

  signOut(name: string): Promise<SharedState> {
    return this.mutate(async () => {
      this.codexSignIns.cancel(name);
      await this.signIns.signOut(name);
      return { save: false, resync: false };
    });
  }

  /* ------------------------------------------------------ multi-machine */

  gatewayState(): Promise<GatewayState> {
    return this.gateway.state();
  }

  saveGatewayConfig(input: GatewayConfig): Promise<GatewayState> {
    return this.gateway.saveConfig(input);
  }

  createDevice(input: { name: string; provider?: string; providers?: string[]; servers: string[] | null }): Promise<{ state: GatewayState; token: string }> {
    return this.gateway.createDevice(input);
  }

  updateDeviceProviders(input: { id: string; providers: string[] }): Promise<GatewayState> {
    return this.gateway.updateDeviceProviders(input);
  }

  revokeDevice(id: string): Promise<GatewayState> {
    return this.gateway.revokeDevice(id);
  }

  deleteDevice(id: string): Promise<GatewayState> {
    return this.gateway.deleteDevice(id);
  }

  connectRemote(input: { name: string; url: string; token: string; provider?: string; providers?: string[] }): Promise<GatewayState> {
    return this.gateway.connectRemote(input);
  }

  refreshRemote(id: string): Promise<GatewayState> {
    return this.gateway.refreshRemote(id);
  }

  disconnectRemote(id: string): Promise<GatewayState> {
    return this.gateway.disconnectRemote(id);
  }

  importServers(source: 'claude' | 'codex' | 'json', json: string | undefined, replace: boolean): Promise<{ state: SharedState; imported: string[]; skipped: string[] }> {
    let imported: string[] = [];
    let skipped: string[] = [];
    return this.mutate(async stored => {
      let parsed: Parsed;
      if (source === 'claude') parsed = await readClaudeServers(this.home);
      else if (source === 'codex') parsed = await readCodexServers(stored.providers.codex?.command ?? 'codex');
      else parsed = parseServerJson(json ?? '');
      skipped = [...parsed.skipped];
      for (const [name, config] of Object.entries(parsed.servers)) {
        if (name in stored.mcpServers && !replace) { skipped.push(`${name}: already shared`); continue; }
        stored.mcpServers[name] = config;
        imported.push(name);
      }
      return { save: imported.length > 0, resync: false };
    }).then(state => ({ state, imported, skipped }));
  }

  updateProvider(input: { provider: string; mcp?: boolean; skills?: boolean; skillsDir?: string }): Promise<SharedState> {
    return this.mutate(async stored => {
      const prefs = { ...stored.providers[input.provider] };
      if (input.mcp !== undefined) prefs.mcp = input.mcp;
      if (input.skills !== undefined) prefs.skills = input.skills;
      if (input.skillsDir !== undefined) {
        if (input.skillsDir.trim()) prefs.skillsDir = input.skillsDir.trim();
        else delete prefs.skillsDir;
      }
      stored.providers[input.provider] = prefs;
      return { save: true, resync: input.skills !== undefined || input.skillsDir !== undefined };
    });
  }

  importSkill(path: string, replace: boolean): Promise<SharedState> {
    return this.mutate(async () => {
      await importSkillDir(expandHome(path, this.home), this.libraryDir, replace, this.backupDir);
      return { save: false, resync: true };
    });
  }

  deleteSkill(name: string): Promise<SharedState> {
    return this.mutate(async stored => {
      await removeFromLibrary(this.libraryDir, name, this.backupDir);
      delete stored.skillAccess[name];
      return { save: true, resync: true };
    });
  }

  updateSkillAccess(input: ProviderAccess & { name: string }): Promise<SharedState> {
    return this.mutate(async stored => {
      const library = await readLibrary(this.libraryDir);
      if (!library.skills.some(skill => skill.name === input.name)) throw new Error(`No library skill is named "${input.name}".`);
      stored.skillAccess[input.name] = providerAccessSchema.parse(input);
      return { save: true, resync: true };
    });
  }

  overwriteSkill(name: string, provider: string): Promise<SharedState> {
    return this.mutate(async () => ({ save: false, resync: true, force: { name, provider } }));
  }

  /**
   * The shared servers to add to a new agent, or null to leave the request alone. The first
   * agent of a provider the plugin has not seen also brings that provider's skills up to date.
   */
  async mcpFor(provider: string, existing: Record<string, unknown> | undefined, paseo: Paseo): Promise<Record<string, McpConfig> | null> {
    // config.json is replaced atomically, so the usual case reads it without waiting for a sync.
    let stored = await this.load();
    if (!stored.providers[provider]?.present) {
      stored = await this.exclusive(async () => {
        const current = await this.load();
        if (await this.refreshProviders(current, paseo).catch(error => { this.log(error); return false; })) {
          await this.save(current);
          await this.sync(current).catch(this.log);
        }
        return current;
      });
    }
    if (!this.row(provider, stored.providers[provider] ?? {}).mcp) return null;
    const added = serversFor(provider, this.servers(stored).valid, existing);
    for (const [name, config] of Object.entries(added)) {
      if (config.type === 'stdio') continue;
      const header = await this.signIns.header(name, config).catch((error: unknown) => { this.log(error); return null; });
      if (header) added[name] = { ...config, headers: { ...config.headers, Authorization: header } };
    }
    // Servers reached through a center gateway, using this host's revocable device credential.
    // Refresh the directory first, so a server just added or removed on the center is reflected;
    // a failed refresh marks the connection failed and yields no cached servers.
    await this.gateway.refreshRemotes(provider).catch(this.log);
    const remote = await this.gateway.remoteServers(provider).catch((error: unknown) => { this.log(error); return {}; });
    for (const [name, config] of Object.entries(remote)) if (added[name] === undefined && existing?.[name] === undefined) added[name] = config;
    return Object.keys(added).length ? added : null;
  }

  /** Syncs once, then again whenever the library changes on disk. */
  start(): void {
    this.gateway.start();
    void this.mutate(async () => ({ save: false, resync: true })).catch(this.log);
    void mkdir(this.libraryDir, { recursive: true }).then(() => {
      if (!this.stopped && this.watcher === null) this.watch();
    }).catch(this.log);
  }

  private watch(): void {
    try {
      this.watcher = watch(this.libraryDir, { recursive: true }, (_event, file) => {
        if (file && /(^|[/\\])\.[^/\\]+\.paseo-tmp-/.test(String(file))) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.stopped) void this.syncNow().catch(this.log);
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', this.log);
    } catch (error) {
      // Without a watcher, edits reach the providers on the next screen visit, Sync now, or new provider.
      this.log(error);
    }
  }

  stop(): void {
    this.stopped = true;
    this.gateway.stop();
    this.signIns.stop();
    this.codexSignIns.stop();
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
