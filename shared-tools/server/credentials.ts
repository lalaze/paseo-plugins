import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tokens } from './oauth';

export const credentialProviders = ['codex', 'claude', 'kimi'] as const;
export type CredentialProvider = typeof credentialProviders[number];
export const credentialLabels: Record<CredentialProvider, string> = { codex: 'Codex', claude: 'Claude Code', kimi: 'Kimi' };
export interface SavedCredential { provider: CredentialProvider; id: string; tokens: Tokens }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function json(path: string): Promise<Record<string, unknown> | null> {
  try { return record(JSON.parse(await readFile(path, 'utf8'))); }
  catch { return null; } // Absent, unreadable or malformed caches must not block another source.
}

/** Compare full resource URLs, never just a host or a server's display name. */
export function sameResource(left: unknown, right: string): boolean {
  if (typeof left !== 'string') return false;
  try {
    const a = new URL(left), b = new URL(right);
    if (![a, b].every(url => ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash)) return false;
    return a.href === b.href;
  } catch { return false; }
}

function token(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value) ? value : undefined;
}

function expiry(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : undefined;
}

function treeName(value: string, limit: number): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `S_${value.replace(/[^A-Za-z0-9_]+/g, '_').slice(0, limit - 11)}-${hash}`;
}

function treeValue(entry: Record<string, unknown> | null): Record<string, unknown> | null {
  if (typeof entry?.expires_at === 'string' && Date.parse(entry.expires_at) <= Date.now()) return null;
  if (typeof entry?.value === 'string') {
    try { return record(JSON.parse(entry.value)); } catch { return null; }
  }
  return record(entry?.value);
}

function candidate(provider: CredentialProvider, id: string, access: unknown, expires: unknown, scope: unknown): SavedCredential | null {
  const accessToken = token(access);
  if (!accessToken) return null;
  // A malformed expiration is not an indefinitely valid token.
  if (expires !== undefined && expires !== null && expiry(expires) === undefined) return null;
  const expiresAt = expiry(expires);
  return { provider, id, tokens: {
    access_token: accessToken,
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(typeof scope === 'string' ? { scope } : {}),
  } };
}

/** Read access tokens only. The originating client retains ownership of refresh tokens. */
export async function savedCredentials(home: string, url: string, only?: CredentialProvider): Promise<SavedCredential[]> {
  const found: SavedCredential[] = [];
  if (!only || only === 'codex') {
    const entries = await json(join(home, '.codex', '.credentials.json'));
    for (const [id, value] of Object.entries(entries ?? {})) {
      const row = record(value);
      if (!row || !sameResource(row.server_url, url)) continue;
      const item = candidate('codex', id, row.access_token, row.expires_at, Array.isArray(row.scopes) ? row.scopes.join(' ') : undefined);
      if (item) found.push(item);
    }
  }
  if (!only || only === 'claude') {
    const entries = record((await json(join(home, '.claude', '.credentials.json')))?.mcpOAuth);
    for (const [id, value] of Object.entries(entries ?? {})) {
      const row = record(value);
      if (!row || !sameResource(row.serverUrl, url)) continue;
      const item = candidate('claude', id, row.accessToken, row.expiresAt, row.scope);
      if (item) found.push(item);
    }
  }
  if (!only || only === 'kimi') {
    // Kimi CLI's FastMCP FileTreeStore uses a hash of the full resource URL.
    for (const base of ['.kimi-code', '.kimi']) {
      const root = join(home, base, 'mcp-oauth');
      if (!sameResource(url, url)) continue;
      const key = url.replace(/\/+$/, '');
      const entry = await json(join(root, treeName('mcp-oauth-token', 245), `${treeName(`${key}/tokens`, 250)}.json`));
      const row = treeValue(entry);
      if (!row || (typeof row.token_type === 'string' && row.token_type.toLowerCase() !== 'bearer')) continue;
      const absolute = treeValue(await json(join(root, treeName('mcp-oauth-token-expiry', 245), `${treeName(`${key}/token_expiry`, 250)}.json`)));
      // The entry TTL is the cache lifetime, not the access token's expiration.
      let expiresAt: unknown = absolute?.expires_at === undefined ? undefined : typeof absolute.expires_at === 'number' ? absolute.expires_at * 1000 : NaN;
      if (expiresAt === undefined && row.expires_in !== undefined && row.expires_in !== null) {
        const created = typeof entry?.created_at === 'string' ? Date.parse(entry.created_at) : NaN;
        if (!Number.isFinite(created) || typeof row.expires_in !== 'number' || !Number.isFinite(row.expires_in) || row.expires_in <= 0) continue;
        expiresAt = created + row.expires_in * 1000;
      }
      const item = candidate('kimi', base, row.access_token, expiresAt, row.scope);
      if (item) found.push(item);
    }
  }
  // Prefer a token with the longest remaining lifetime, irrespective of CLI priority.
  return found.sort((a, b) => (b.tokens.expires_at ?? Infinity) - (a.tokens.expires_at ?? Infinity));
}
