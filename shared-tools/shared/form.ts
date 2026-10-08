import { ui } from './i18n';
import { mcpConfigSchema, nameSchema, type McpConfig, type McpServer } from './rpc';

/** What the add/edit form holds: one argument per line, `KEY=value` env lines, `Name: value` header lines. */
export interface ServerDraft {
  name: string;
  enabled: boolean;
  providers: string[] | null;
  type: McpConfig['type'];
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

export function blankDraft(): ServerDraft {
  return { name: '', enabled: true, providers: null, type: 'stdio', command: '', args: '', env: '', url: '', headers: '' };
}

export function draftFrom(server: McpServer): ServerDraft {
  const { config } = server;
  const base = { ...blankDraft(), name: server.name, enabled: server.enabled, providers: server.providers, type: config.type };
  if (config.type === 'stdio') {
    return { ...base, command: config.command, args: (config.args ?? []).join('\n'), env: Object.entries(config.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n') };
  }
  return { ...base, url: config.url, headers: Object.entries(config.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n') };
}

/** Splits each line at its first `separator`, so values may contain it. */
function pairs(text: string, separator: '=' | ':', label: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    const at = line.indexOf(separator);
    if (at <= 0) throw new Error(ui(`${label}: "${line}" needs a name before "${separator}".`, `${label}：“${line}” 的 "${separator}" 前缺少名称。`));
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/** The server to save, or the first problem with the draft. */
export function serverFromDraft(draft: ServerDraft): { server: McpServer } | { error: string } {
  const name = nameSchema.safeParse(draft.name);
  if (!name.success) return { error: ui('Name: use letters, digits, "_" and "-" only.', '名称只能包含字母、数字、"_" 和 "-"。') };
  try {
    let config: McpConfig;
    if (draft.type === 'stdio') {
      if (!draft.command.trim()) return { error: ui('Command is required.', '请填写命令。') };
      const args = draft.args.split(/\r?\n/).map(a => a.trim()).filter(Boolean);
      const env = pairs(draft.env, '=', ui('Environment', '环境变量'));
      config = mcpConfigSchema.parse({ type: 'stdio', command: draft.command.trim(), ...(args.length ? { args } : {}), ...(env ? { env } : {}) });
    } else {
      if (!/^https?:\/\/\S+$/i.test(draft.url.trim())) return { error: ui('URL must start with http:// or https://.', 'URL 必须以 http:// 或 https:// 开头。') };
      const headers = pairs(draft.headers, ':', ui('Headers', '请求头'));
      config = mcpConfigSchema.parse({ type: draft.type, url: draft.url.trim(), ...(headers ? { headers } : {}) });
    }
    return { server: { name: name.data, enabled: draft.enabled, providers: draft.providers, config } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** True when every space-separated word of the query appears in one of the texts, ignoring case. */
export function matchesQuery(query: string, ...texts: (string | null | undefined)[]): boolean {
  const haystack = texts.filter(Boolean).join('\n').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}

/** A server with its own Authorization header uses that; only the others can sign in. */
export function hasAuthHeader(config: McpConfig): boolean {
  return config.type !== 'stdio' && Object.keys(config.headers ?? {}).some(name => name.toLowerCase() === 'authorization');
}

/** One line for the server list: the command with its arguments, or the URL. */
export function summarize(config: McpConfig): string {
  return config.type === 'stdio' ? [config.command, ...(config.args ?? [])].join(' ') : config.url;
}
