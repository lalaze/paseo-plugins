import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import type { ProviderUpdate } from '../shared/rpc';
import { classifyInstall, compareVersions, installRoots, parseVersion, readDiagnostic, scriptOf, unknown, type Feed, type Installer, type InstallRoots } from './detect';

export interface RunResult { code: number | null; output: string }
export type Runner = (argv: string[], options: { pathPrefix: string | null; env?: Record<string, string> | null; timeoutMs: number }) => Promise<RunResult>;
type Providers = Pick<PaseoApi['providers'], 'snapshot' | 'diagnostic' | 'refresh'>;

interface Inspection { label: string; binary: string | null; installer: Installer; current: string | null; latest: string | null; error: string | null }
interface Outcome { state: 'updated' | 'failed'; message: string; finishedAt: string }

const INSPECTION_TTL = 10 * 60_000;
const UPDATE_TIMEOUT = 10 * 60_000;
const OUTPUT_TAIL = 2000;
const SCRIPT: Installer = { ...unknown, kind: 'script' };

export const runProcess: Runner = (argv, { pathPrefix, env: extra, timeoutMs }) => new Promise(resolve => {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', CI: '1', ...extra };
  if (pathPrefix) env.PATH = `${pathPrefix}:${env.PATH ?? ''}`;
  let output = '';
  const child = spawn(argv[0], argv.slice(1), { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4 * OUTPUT_TAIL); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const timer = setTimeout(() => { output += '\nTimed out.'; child.kill('SIGTERM'); }, timeoutMs);
  child.on('error', error => { clearTimeout(timer); resolve({ code: null, output: error.message }); });
  child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
});

/** Reads a release feed. npm uses the registry npm itself is configured with, so mirrors and proxies apply. */
export function feedLatest(run: Runner, fetchText: (url: string) => Promise<string> = fetchPlain): (feed: Feed) => Promise<string | null> {
  return async feed => {
    if (feed.kind === 'url') return parseVersion(await fetchText(feed.url));
    const [argv, env] = feed.kind === 'npm' ? [['npm', 'view', `${feed.name}@latest`, 'version'], null] : [feed.argv, feed.env];
    const { code, output } = await run(argv, { pathPrefix: null, env, timeoutMs: 30_000 });
    if (code !== 0) return null;
    const text = output.split('\n').filter(line => !line.startsWith('(node:')).join('\n');
    if (feed.kind === 'npm') return parseVersion(text);
    const line = text.split('\n').find(candidate => candidate.trimStart().startsWith('{'));
    const value = line ? (JSON.parse(line) as Record<string, unknown>)[feed.field] : null;
    return typeof value === 'string' ? parseVersion(value) : null;
  };
}

async function fetchPlain(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** The version in the nearest package.json above a script, which is what a local provider script ships as. */
async function packageVersion(script: string, read: (path: string) => Promise<string>): Promise<string | null> {
  for (let dir = dirname(script); ; dir = dirname(dir)) {
    const text = await read(join(dir, 'package.json')).catch(() => null);
    if (text !== null) {
      try {
        const { version } = JSON.parse(text) as { version?: unknown };
        return typeof version === 'string' ? parseVersion(version) : null;
      } catch {
        return null;
      }
    }
    if (dir === dirname(dir)) return null;
  }
}

function tail(text: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return plain.length > OUTPUT_TAIL ? `…${plain.slice(-OUTPUT_TAIL)}` : plain;
}

export class ProviderUpdates {
  private readonly inspections = new Map<string, Promise<Inspection>>();
  private readonly latest = new Map<string, Promise<string | null>>();
  private readonly outcomes = new Map<string, Outcome>();
  private checkedAt = 0;
  private running: string | null = null;
  private roots: Promise<InstallRoots> | undefined;

  constructor(private readonly deps: {
    run?: Runner;
    latest?: (feed: Feed) => Promise<string | null>;
    home?: string;
    now?: () => number;
    resolve?: (path: string) => Promise<string>;
    read?: (path: string) => Promise<string>;
  } = {}) {}

  private get run() { return this.deps.run ?? runProcess; }
  private get read() { return this.deps.read ?? ((path: string) => readFile(path, 'utf8')); }
  private now() { return (this.deps.now ?? Date.now)(); }

  async list(providers: Providers, refresh: boolean): Promise<{ checkedAt: string; providers: ProviderUpdate[] }> {
    if (refresh || this.now() - this.checkedAt >= INSPECTION_TTL) {
      this.inspections.clear();
      this.latest.clear();
      this.checkedAt = this.now();
    }
    const snapshot = await providers.snapshot();
    const enabled = snapshot.entries.filter(entry => entry.enabled);
    const rows = await Promise.all(enabled.map(entry => this.row(providers, entry.provider, entry.label)));
    return { checkedAt: new Date(this.checkedAt).toISOString(), providers: rows };
  }

  async update(providers: Providers, provider: string): Promise<ProviderUpdate> {
    const snapshot = await providers.snapshot();
    const entry = snapshot.entries.find(candidate => candidate.provider === provider);
    if (!entry?.enabled) throw new Error(`Provider ${provider} is not enabled on this host.`);
    if (this.running) throw new Error(`${this.running} is already updating; wait for it to finish.`);
    // Inspect afresh so the command targets whatever binary the daemon resolves right now.
    this.inspections.delete(provider);
    const inspection = await this.inspect(providers, provider, entry.label);
    const command = inspection.installer.command;
    if (!command) throw new Error(inspection.error ?? `No known way to update ${inspection.label}; update it manually.`);
    if (this.running) throw new Error(`${this.running} is already updating; wait for it to finish.`);
    this.running = provider;
    this.outcomes.delete(provider);
    void this.run(command, { pathPrefix: inspection.installer.pathPrefix, env: inspection.installer.env, timeoutMs: UPDATE_TIMEOUT })
      .then(({ code, output }) => ({ ok: code === 0, message: tail(output) || (code === 0 ? '' : `Exited with code ${code}.`) }))
      .catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }))
      .then(async ({ ok, message }) => {
        this.outcomes.set(provider, { state: ok ? 'updated' : 'failed', message, finishedAt: new Date(this.now()).toISOString() });
        this.inspections.delete(provider);
        if (inspection.installer.feed) this.latest.delete(JSON.stringify(inspection.installer.feed));
        this.running = null;
        // Let Paseo re-read the provider so its version and models match the new binary.
        await providers.refresh({ providers: [provider] }).catch(() => undefined);
      });
    return this.row(providers, provider, entry.label);
  }

  private async row(providers: Providers, provider: string, label: string | undefined): Promise<ProviderUpdate> {
    let inspection = this.inspections.get(provider);
    if (!inspection) {
      inspection = this.inspect(providers, provider, label);
      this.inspections.set(provider, inspection);
    }
    const { binary, installer, current, latest, error, label: resolvedLabel } = await inspection;
    const outcome = this.outcomes.get(provider);
    return {
      provider,
      label: resolvedLabel,
      binary,
      install: installer.kind,
      current,
      latest,
      updateAvailable: Boolean(current && latest && compareVersions(latest, current) > 0),
      canUpdate: installer.command !== null,
      state: this.running === provider ? 'updating' : outcome?.state ?? 'idle',
      message: this.running === provider ? null : outcome?.message ?? error,
      finishedAt: this.running === provider ? null : outcome?.finishedAt ?? null,
    };
  }

  private async inspect(providers: Providers, provider: string, label: string | undefined): Promise<Inspection> {
    let name = label || provider;
    let diagnostic: string;
    try {
      diagnostic = (await providers.diagnostic(provider)).diagnostic;
    } catch (error) {
      return { label: name, binary: null, installer: unknown, current: null, latest: null, error: `Could not read the ${name} diagnostic: ${error instanceof Error ? error.message : String(error)}` };
    }
    const { title, resolvedPath, version, command } = readDiagnostic(diagnostic);
    if (!label && title) name = title;
    if (!resolvedPath) {
      return { label: name, binary: null, installer: unknown, current: parseVersion(version), latest: null, error: `Paseo did not report an executable for ${name}.` };
    }
    const resolve = this.deps.resolve ?? realpath;
    // `node hub.mjs`: the version row is the interpreter's, and no installer owns the script.
    const script = scriptOf(resolvedPath, command);
    if (script) {
      const current = await packageVersion(script, this.read);
      return { label: name, binary: script, installer: SCRIPT, current, latest: null, error: null };
    }
    const binary = await resolve(resolvedPath).catch(() => resolvedPath);
    this.roots ??= installRoots(this.deps.home ?? homedir(), resolve, this.read);
    const installer = classifyInstall(binary, await this.roots);
    const [current, latest] = await Promise.all([
      parseVersion(version) ?? this.versionOf(resolvedPath),
      installer.feed ? this.latestOf(installer.feed) : null,
    ]);
    return { label: name, binary, installer, current, latest, error: null };
  }

  /** Some diagnostics omit the version row; ask the executable itself. */
  private async versionOf(binary: string): Promise<string | null> {
    const { code, output } = await this.run([binary, '--version'], { pathPrefix: null, timeoutMs: 15_000 }).catch(() => ({ code: null, output: '' }));
    return code === 0 ? parseVersion(output) : null;
  }

  private latestOf(feed: Feed): Promise<string | null> {
    const key = JSON.stringify(feed);
    let pending = this.latest.get(key);
    if (!pending) {
      pending = (this.deps.latest ?? feedLatest(this.run))(feed).catch(() => null);
      this.latest.set(key, pending);
    }
    return pending;
  }
}
