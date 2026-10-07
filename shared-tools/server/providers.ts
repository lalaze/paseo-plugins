import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

/** PASEO_SHARED_TOOLS_DIR, or $PASEO_HOME/shared-tools, or ~/.paseo/shared-tools. */
export function sharedToolsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_SHARED_TOOLS_DIR ?? join(env.PASEO_HOME ?? join(homedir(), '.paseo'), 'shared-tools');
}

/**
 * The user-level folder each CLI reads skills from, relative to the home directory. Looked up
 * by provider id first, then by the name of the executable a custom provider runs, so a
 * provider named `kimi` that runs `kimi acp` finds Kimi Code's folder.
 */
const SKILL_DIRS: Record<string, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  grok: '.grok/skills',
  kimi: '.kimi-code/skills',
  codebuddy: '.codebuddy/skills',
  'codebuddy-code': '.codebuddy/skills',
  pi: '.pi/agent/skills',
  opencode: '.config/opencode/skills',
  copilot: '.copilot/skills',
  gemini: '.gemini/skills',
  cursor: '.cursor/skills',
  'cursor-agent': '.cursor/skills',
};

export function knownSkillsDir(provider: string, command: string | null, home = homedir()): string | null {
  const relative = SKILL_DIRS[provider] ?? (command ? SKILL_DIRS[basename(command).replace(/\.(exe|cmd)$/i, '')] : undefined);
  return relative ? join(home, relative) : null;
}

/** `~/x` and relative paths are taken from the home directory, as a person would type them. */
export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(home, path);
}

/**
 * Providers that cannot take MCP servers from Paseo. Paseo refuses to start an agent whose
 * provider is handed one it cannot run, so these start switched off.
 */
const MCP_OFF: Record<string, string> = {
  pi: 'Pi only runs MCP servers with the pi-mcp-adapter extension installed; without it, new Pi agents would fail to start.',
  omp: 'Paseo does not pass MCP servers to this provider.',
};

export function mcpDefault(provider: string): { on: boolean; note: string | null } {
  const note = MCP_OFF[provider] ?? null;
  return { on: note === null, note };
}
