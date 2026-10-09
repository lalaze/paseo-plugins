import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export interface AntigravityQuotaWindow {
  id: string;
  label: string;
  shortLabel?: string;
  usedPct: number;
  remainingPct: number;
  resetsAt: string | null;
  tone: 'ok' | 'warning' | 'danger';
}

const USAGE_PRINT_VERSION = [1, 1, 11] as const;

/** `agy -p /usage` is a quota command only from CLI 1.1.11. Older releases treat it as a prompt. */
export function supportsUsagePrint(versionText: string): boolean {
  const match = String(versionText).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < USAGE_PRINT_VERSION.length; i += 1) {
    const part = version[i] ?? 0;
    const minimum = USAGE_PRINT_VERSION[i] ?? 0;
    if (part > minimum) return true;
    if (part < minimum) return false;
  }
  return true;
}

/** Official agy only. Retired antigravity-hub / antigravity-acp paths are not consulted. */
export function agyCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const explicit = env.PASEO_ANTIGRAVITY_BIN || env.ANTIGRAVITY_CLI_PATH;
  const fromPath = (env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'agy'));
  return [explicit, ...fromPath, join(home, '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy', join(home, '.gemini/bin/agy')]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export async function resolveOfficialAgy(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of agyCandidates(env, home)) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, 1);
      const real = await realpath(candidate);
      if (seen.has(real)) continue;
      seen.add(real);
      return real;
    } catch { /* Try the next official install location. */ }
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function fraction(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function reset(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function tone(usedPct: number): AntigravityQuotaWindow['tone'] {
  return usedPct > 90 ? 'danger' : usedPct >= 70 ? 'warning' : 'ok';
}

function groupsOf(payload: Record<string, unknown>): unknown[] {
  const command = objectValue(payload.command);
  const data = objectValue(command?.data);
  if (Array.isArray(data?.groups)) return data.groups;
  const response = objectValue(payload.response);
  if (Array.isArray(response?.groups)) return response.groups;
  return Array.isArray(payload.groups) ? payload.groups : [];
}

/** Convert an official `/usage` envelope into remaining-percent windows. A model turn is refused. */
export function quotaWindows(payload: unknown): AntigravityQuotaWindow[] {
  const root = objectValue(payload);
  if (!root) return [];
  const command = objectValue(root.command);
  if (command && command.name !== 'usage') return [];
  if (typeof root.num_turns === 'number' && root.num_turns > 0) return [];
  const windows: AntigravityQuotaWindow[] = [];
  const seen = new Set<string>();
  for (const [gi, groupValue] of groupsOf(root).entries()) {
    const group = objectValue(groupValue);
    if (!group) continue;
    const name = typeof group.name === 'string' ? group.name : typeof group.displayName === 'string' ? group.displayName : `Group ${gi + 1}`;
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const [bi, bucketValue] of buckets.entries()) {
      const bucket = objectValue(bucketValue);
      if (!bucket) continue;
      const remaining = objectValue(bucket.remaining);
      const remainingFraction = fraction(bucket.remaining_fraction ?? bucket.remainingFraction ?? remaining?.remainingFraction);
      if (remainingFraction === null) continue;
      const id = typeof bucket.id === 'string' && bucket.id ? bucket.id : typeof bucket.bucketId === 'string' && bucket.bucketId ? bucket.bucketId : `agy_${gi}_${bi}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const window = bucket.window === 'weekly' || bucket.window === '5h' ? bucket.window : null;
      const period = window === 'weekly' ? 'Weekly limit' : window === '5h' ? '5-hour limit' : 'Quota';
      const usedPct = Math.round((1 - remainingFraction) * 10000) / 100;
      windows.push({
        id,
        label: `${name} · ${period}`,
        ...(window === 'weekly' ? { shortLabel: 'wk' } : window === '5h' ? { shortLabel: '5h' } : {}),
        usedPct,
        remainingPct: Math.max(0, Math.round((100 - usedPct) * 100) / 100),
        resetsAt: reset(bucket.reset_time ?? bucket.resetTime ?? remaining?.resetTime),
        tone: tone(usedPct),
      });
    }
  }
  return windows;
}

function capture(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(!error && typeof stdout === 'string' ? stdout : null);
    });
  });
}

export interface OfficialQuotaReader {
  resolve?: typeof resolveOfficialAgy;
  run?: (file: string, args: string[], timeoutMs: number) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function reader(options: OfficialQuotaReader) {
  return {
    env: options.env ?? process.env,
    home: options.home ?? homedir(),
    resolve: options.resolve ?? resolveOfficialAgy,
    run: options.run ?? capture,
  };
}

/** True when the official CLI is installed and new enough for the read-only usage command. */
export async function officialAgyReady(options: OfficialQuotaReader = {}): Promise<boolean> {
  const current = reader(options);
  const bin = await current.resolve(current.env, current.home);
  if (!bin) return false;
  const version = await current.run(bin, ['--version'], 3000);
  return !!version && supportsUsagePrint(version);
}

/** Read the signed-in official agy account. Does not start a Hub and does not send a model prompt. */
export async function readOfficialQuota(options: OfficialQuotaReader = {}): Promise<AntigravityQuotaWindow[] | null> {
  const current = reader(options);
  const bin = await current.resolve(current.env, current.home);
  if (!bin) return null;
  const version = await current.run(bin, ['--version'], 3000);
  if (!version || !supportsUsagePrint(version)) return null;
  // CLI startup can take over 15s; stay below Paseo's 30s plugin RPC deadline.
  const stdout = await current.run(bin, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '12s'], 25000);
  if (!stdout) return null;
  try {
    const windows = quotaWindows(JSON.parse(stdout));
    return windows.length ? windows : null;
  } catch {
    return null;
  }
}
