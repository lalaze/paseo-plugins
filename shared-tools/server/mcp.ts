import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mcpConfigSchema, nameSchema, type McpConfig } from '../shared/rpc';

/** Servers Paseo adds itself: the daemon's own tools and collaboration's director. */
export const RESERVED_SERVERS = new Set(['paseo', 'director']);

/** How a shared server is kept on disk: the usual `mcpServers` entry plus two plugin keys. */
export type StoredServer = McpConfig & { enabled?: boolean; providers?: string[] };

const KNOWN_TYPES = new Set(['stdio', 'http', 'sse', 'streamable-http', 'streamablehttp']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strings(value: unknown): Record<string, string> | undefined {
  const entries = Object.entries(record(value) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Reads one server from the formats people paste: Claude/Cursor/Gemini `mcpServers` entries
 * (`type` optional, Gemini's `httpUrl`), and Codex's `mcp list --json` transport.
 */
export function normalizeServer(raw: unknown): McpConfig {
  const entry = record(raw);
  if (!entry) throw new Error('Expected an object.');
  const source = record(entry.transport) ?? entry;
  const type = typeof source.type === 'string' ? source.type.toLowerCase().replaceAll('_', '-') : null;
  const url = typeof source.url === 'string' ? source.url : typeof source.httpUrl === 'string' ? source.httpUrl : null;
  const alwaysLoad = entry.alwaysLoad === true ? { alwaysLoad: true } : {};
  if (type !== null && !KNOWN_TYPES.has(type)) throw new Error(`Transport "${type}" is not supported.`);
  if (typeof source.command === 'string' && (type === null || type === 'stdio')) {
    const args = Array.isArray(source.args) ? source.args.filter((arg): arg is string => typeof arg === 'string') : [];
    const env = strings(source.env);
    return mcpConfigSchema.parse({ type: 'stdio', command: source.command, ...(args.length ? { args } : {}), ...(env ? { env } : {}), ...alwaysLoad });
  }
  if (url && type !== 'stdio') {
    if (typeof source.bearer_token_env_var === 'string') throw new Error(`Reads its token from $${source.bearer_token_env_var}; add it as an Authorization header instead.`);
    const headers = strings(source.headers) ?? strings(source.http_headers);
    const bearer = typeof source.bearer_token === 'string' ? source.bearer_token : null;
    const merged = bearer ? { ...headers, Authorization: `Bearer ${bearer}` } : headers;
    const kind = type === 'sse' ? 'sse' : 'http';
    return mcpConfigSchema.parse({ type: kind, url, ...(merged ? { headers: merged } : {}), ...alwaysLoad });
  }
  throw new Error(type === 'stdio' ? 'Needs a "command".' : type ? 'Needs a "url".' : 'Needs a "command" or a "url".');
}

export interface Parsed { servers: Record<string, McpConfig>; skipped: string[] }

/** Accepts `{ "mcpServers": {...} }`, a bare name → server map, or a Codex `mcp list --json` array. */
export function parseServerList(input: unknown): Parsed {
  const servers: Record<string, McpConfig> = {};
  const skipped: string[] = [];
  const add = (name: string, raw: unknown) => {
    const valid = nameSchema.safeParse(name);
    if (!valid.success || RESERVED_SERVERS.has(valid.data)) { skipped.push(`${name}: ${valid.success ? 'reserved by Paseo' : 'invalid name'}`); return; }
    try { servers[valid.data] = normalizeServer(raw); }
    catch (error) { skipped.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  if (Array.isArray(input)) {
    for (const item of input) {
      const entry = record(item);
      if (typeof entry?.name === 'string') add(entry.name, entry);
    }
    return { servers, skipped };
  }
  const object = record(input);
  if (!object) throw new Error('Expected a JSON object or array.');
  const map = record(object.mcpServers) ?? record(object.mcp_servers) ?? record(object.servers) ?? object;
  for (const [name, raw] of Object.entries(map)) add(name, raw);
  return { servers, skipped };
}

export function parseServerJson(text: string): Parsed {
  let input: unknown;
  try { input = JSON.parse(text); }
  catch { throw new Error('That is not valid JSON.'); }
  return parseServerList(input);
}

/** Claude Code's user-scope servers live at the top of `~/.claude.json`. */
export async function readClaudeServers(home = homedir()): Promise<Parsed> {
  const text = await readFile(join(home, '.claude.json'), 'utf8').catch(() => null);
  if (text === null) throw new Error('~/.claude.json was not found.');
  const config = record(JSON.parse(text));
  return parseServerList({ mcpServers: record(config?.mcpServers) ?? {} });
}

/** Asks Codex itself, so its config.toml never has to be parsed here. */
export async function readCodexServers(command = 'codex'): Promise<Parsed> {
  const { stdout } = await promisify(execFile)(command, ['mcp', 'list', '--json'], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
    .catch((error: unknown) => { throw new Error(`codex mcp list failed: ${error instanceof Error ? error.message : String(error)}`); });
  const list = JSON.parse(stdout) as unknown;
  if (!Array.isArray(list)) throw new Error('codex mcp list --json did not return a list.');
  // Servers switched off in Codex stay off: importing one should not quietly turn it on elsewhere.
  const parsed = parseServerList(list.filter(item => record(item)?.enabled !== false));
  const disabled = list.filter(item => record(item)?.enabled === false).map(item => `${String(record(item)?.name)}: disabled in Codex`);
  return { servers: parsed.servers, skipped: [...parsed.skipped, ...disabled] };
}

export function stripStored(server: StoredServer): McpConfig {
  const { enabled: _enabled, providers: _providers, ...config } = server;
  return mcpConfigSchema.parse(config);
}

/**
 * The servers to add to a new agent of `provider`. A server the request already names is
 * left as the caller set it, and Paseo's own servers are never replaced.
 */
export function serversFor(provider: string, shared: Record<string, StoredServer>, existing: Record<string, unknown> | undefined): Record<string, McpConfig> {
  const added: Record<string, McpConfig> = {};
  for (const [name, server] of Object.entries(shared)) {
    if (server.enabled === false || RESERVED_SERVERS.has(name) || existing?.[name] !== undefined) continue;
    if (server.providers && !server.providers.includes(provider)) continue;
    added[name] = stripStored(server);
  }
  return added;
}
