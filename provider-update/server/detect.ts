import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { InstallKind } from '../shared/rpc';

/** Where the newest release number comes from. */
export type Feed =
  | { kind: 'npm'; name: string }
  /** A plain-text version at a URL. */
  | { kind: 'url'; url: string }
  /** A command that prints JSON with the version in `field`. */
  | { kind: 'command'; argv: string[]; env: Record<string, string> | null; field: string };

export interface Installer {
  kind: InstallKind;
  /** argv of the upgrade; null when the install method is not recognised. */
  command: string[] | null;
  /** Prepended to PATH so a global npm install runs with the node of its own prefix. */
  pathPrefix: string | null;
  /** Extra environment for the upgrade. */
  env: Record<string, string> | null;
  /** Null when there is no version feed; the updater itself then decides. */
  feed: Feed | null;
}

/** Reads the rows Paseo prints in `paseo provider diagnostic` for a command-launched provider. */
export function readDiagnostic(text: string): { title: string | null; resolvedPath: string | null; version: string | null; command: string | null } {
  const lines = text.split('\n');
  // A row's value runs until the next indented "Label:" row; CLI warnings can push the version onto later lines.
  const row = (label: string) => {
    const start = lines.findIndex(line => line.trimStart().startsWith(`${label}:`));
    if (start < 0) return null;
    const value = [lines[start].trimStart().slice(label.length + 1)];
    for (const line of lines.slice(start + 1)) {
      if (/^\s+[^\s:][^:]*:(\s|$)/.test(line)) break;
      value.push(line);
    }
    return value.join('\n').trim() || null;
  };
  const resolvedPath = row('Resolved path');
  // The first, unindented line names the provider ("Claude Code", "Codex").
  const title = /^(\S.*?)\s*$/m.exec(text)?.[1] ?? null;
  return { title, resolvedPath: resolvedPath?.startsWith('/') ? resolvedPath : null, version: row('Version'), command: row('Configured command') };
}

const INTERPRETER = /^(node|bun|deno|tsx|python(\d+(\.\d+)?)?|ruby|perl)$/;

/**
 * The script a configured command hands to an interpreter (`node hub.mjs run`), or null when the
 * launcher is the provider itself. Paseo prints the command space-joined, so a path with spaces is not found.
 */
export function scriptOf(launcher: string, command: string | null): string | null {
  if (!INTERPRETER.test(basename(launcher)) || !command) return null;
  const script = command.split(/\s+/).slice(1).find(arg => !arg.startsWith('-'));
  return script?.startsWith('/') ? script : null;
}

export function parseVersion(text: string | null | undefined): string | null {
  return text ? /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(text)?.[0] ?? null : null;
}

/** Semver precedence, enough for CLI release numbers: a release outranks its prereleases. */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = split(a), [coreB, preB] = split(b);
  for (let i = 0; i < 3; i++) if (coreA[i] !== coreB[i]) return coreA[i] - coreB[i];
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0;
  const partsA = preA.split('.'), partsB = preB.split('.');
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i], y = partsB[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const order = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (order) return order;
  }
  return 0;
}

function split(version: string): [number[], string | undefined] {
  const [core, ...pre] = version.split('-');
  return [core.split('.').map(Number), pre.length ? pre.join('-') : undefined];
}

export const unknown: Installer = { kind: 'unknown', command: null, pathPrefix: null, env: null, feed: null };

/** Directories the self-updating CLIs install into, as written and as resolved: home dirs are often symlinked elsewhere. */
export interface InstallRoots {
  claude: string[];
  codex: string[];
  grok: string[];
  kimi: string[];
  /** Kimi publishes releases per region; `kimi login` records which one in `~/.kimi-code/region`. */
  kimiCdn: string;
}

const KIMI_CDN: Record<string, string> = { 'mainland-cn': 'https://code.kimi.com/kimi-code', global: 'https://code.kimi.ai/kimi-code' };

export async function installRoots(
  home: string,
  resolve: (path: string) => Promise<string>,
  read: (path: string) => Promise<string> = path => readFile(path, 'utf8'),
): Promise<InstallRoots> {
  const both = async (path: string) => [...new Set([path, await resolve(path).catch(() => path)])];
  const region = (await read(join(home, '.kimi-code/region')).catch(() => '')).trim();
  return {
    claude: await both(join(home, '.local/share/claude/versions')),
    codex: await both(join(home, '.codex/packages/standalone')),
    grok: await both(join(home, '.grok/downloads')),
    kimi: await both(join(home, '.kimi-code/bin')),
    kimiCdn: KIMI_CDN[region] ?? KIMI_CDN['mainland-cn'],
  };
}

const within = (path: string, roots: string[]) => roots.some(root => path.startsWith(root + '/'));

/**
 * Maps the real path of a provider executable to the installer that owns it.
 * Only these fixed commands ever run; nothing from the client reaches argv.
 */
export function classifyInstall(realPath: string, roots: InstallRoots): Installer {
  if (within(realPath, roots.claude)) {
    return { kind: 'claude-native', command: [realPath, 'update'], pathPrefix: null, env: null, feed: { kind: 'npm', name: '@anthropic-ai/claude-code' } };
  }
  if (within(realPath, roots.codex)) {
    return { kind: 'codex-standalone', command: [realPath, 'update'], pathPrefix: null, env: null, feed: { kind: 'npm', name: '@openai/codex' } };
  }
  if (within(realPath, roots.grok)) {
    // Grok guesses its installer from the environment and can settle on npm, whose package is not this build.
    const env = { GROK_INSTALLER: 'internal' };
    return {
      kind: 'grok-standalone',
      command: [realPath, 'update'],
      pathPrefix: null,
      env,
      feed: { kind: 'command', argv: [realPath, 'update', '--check', '--json'], env, field: 'latestVersion' },
    };
  }
  if (within(realPath, roots.kimi)) {
    return { kind: 'kimi-standalone', command: [realPath, 'upgrade', '--yes'], pathPrefix: null, env: null, feed: { kind: 'url', url: `${roots.kimiCdn}/latest` } };
  }
  const npm = /^(\/.*?)\/lib\/node_modules\/((?:@[^/]+\/)?[^/@][^/]*)\//.exec(realPath);
  if (npm) {
    const [, prefix, name] = npm;
    return {
      kind: 'npm',
      command: [join(prefix, 'bin/npm'), 'install', '--global', '--no-fund', '--no-audit', `${name}@latest`],
      pathPrefix: join(prefix, 'bin'),
      env: null,
      feed: { kind: 'npm', name },
    };
  }
  const brew = /^(\/.*?)\/(Cellar|Caskroom)\/([^/]+)\//.exec(realPath);
  if (brew) {
    const [, prefix, room, name] = brew;
    return {
      kind: room === 'Cellar' ? 'homebrew' : 'homebrew-cask',
      command: [join(prefix, 'bin/brew'), 'upgrade', ...(room === 'Cellar' ? [] : ['--cask']), name],
      pathPrefix: join(prefix, 'bin'),
      env: null,
      feed: null,
    };
  }
  return unknown;
}
