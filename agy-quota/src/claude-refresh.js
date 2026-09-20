import { promises as fs } from 'node:fs';
import { join, delimiter, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const attempts = new Map();
const expiring = (value, now) => Number.isFinite(value?.oauth?.expiresAt) && value.oauth.expiresAt <= now + 300000;
const refreshable = value => Boolean(value?.oauth?.refreshToken);
const fresh = (value, now) => Boolean(value?.oauth?.accessToken) && Number.isFinite(value.oauth.expiresAt) && !expiring(value, now);
const failure = () => new Error('Claude credential renewal unavailable; open Claude Code to renew or sign in');

/** The CLI owns OAuth rotation and locking. Only re-read its output; never write tokens. */
export function createClaudeCredentialReader(read, { claudeHome, run = renewWithClaude, now = Date.now, state = attempts } = {}) {
  return async () => {
    const current = await read();
    if (!expiring(current, now()) || !refreshable(current)) return current;
    let attempt = state.get(claudeHome);
    if (!attempt?.pending && (!attempt || now() >= attempt.retryAt)) {
      attempt = { retryAt: now() + 60000, pending: null };
      state.set(claudeHome, attempt);
      attempt.pending = Promise.resolve().then(() => run(claudeHome, { read, now })).catch(() => {
        // CLI output and OAuth errors can contain secrets; never forward them.
      }).finally(() => { attempt.retryAt = now() + 60000; attempt.pending = null; });
    }
    if (attempt?.pending) await attempt.pending;
    const updated = await read();
    if (fresh(updated, now())) { state.delete(claudeHome); return updated; }
    // A proactive attempt may fail while the current access token is still usable.
    if (updated?.oauth?.expiresAt > now()) return updated;
    throw failure();
  };
}

export function claudeProbeEnvironment(claudeHome, base = process.env) {
  const env = { ...base, CLAUDE_CONFIG_DIR: claudeHome, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  // Setting CLAUDE_CONFIG_DIR even to ~/.claude moves Claude's global config
  // from ~/.claude.json to ~/.claude/.claude.json and triggers onboarding.
  if (!base.CLAUDE_CONFIG_DIR && resolve(claudeHome) === join(homedir(), '.claude')) delete env.CLAUDE_CONFIG_DIR;
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SIMPLE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
  return env;
}

async function binaryPath() {
  const candidates = process.env.PASEO_CLAUDE_BIN ? [process.env.PASEO_CLAUDE_BIN] : [
    ...(process.env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'claude')),
    join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
  ];
  for (const bin of candidates) {
    if (!isAbsolute(bin)) continue;
    try { await fs.access(bin, 1); return bin; } catch { /* Try next absolute candidate. */ }
  }
  throw failure();
}

/** Isolated PTY /status probe, bounded to 20s; no model prompt or direct OAuth POST. */
export async function renewWithClaude(claudeHome, dependencies = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw failure();
  const bin = dependencies.bin ?? await binaryPath();
  const cwd = dependencies.cwd ?? join(process.env.PASEO_HOME || join(homedir(), '.paseo'), 'cache', 'claude-renewal-probe');
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
  const start = dependencies.spawn ?? require('node-pty').spawn;
  const now = dependencies.now ?? Date.now;
  const read = dependencies.read;
  if (typeof read !== 'function') throw failure();
  const child = start(bin, [
    '--safe-mode', '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true, remoteControlAtStartup: false }),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--no-chrome',
    '--permission-mode', 'dontAsk', '/status',
  ], { cwd, env: claudeProbeEnvironment(claudeHome), cols: 140, rows: 40, name: 'xterm-256color' });
  let exited = false, tail = '', trusted = false, statusSeen = false, outputSize = 0, selectTrustAt = null, confirmTrustAt = null, trustNeedsDown = false;
  const terminate = signal => { if (!exited) { try { child.kill(signal); } catch { /* Already gone. */ } } };
  const onParentExit = () => terminate('SIGKILL');
  process.once('exit', onParentExit);
  const exitListener = child.onExit(() => { exited = true; });
  const dataListener = child.onData(chunk => {
    outputSize += chunk.length;
    if (outputSize > 512 * 1024) { terminate('SIGTERM'); return; }
    tail = (tail + chunk).slice(-16000);
    if (chunk.includes('\x1b[6n')) child.write('\x1b[1;1R');
    const text = tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, '');
    // Only this empty probe directory is trusted. Never answer login/permissions dialogs.
    if (!trusted && text.includes('Yes,Itrustthisfolder')) {
      trusted = true;
      trustNeedsDown = text.includes('❯No,exit');
      // Claude 2.1.274 rejects confirmation keys during its initial input guard.
      selectTrustAt = Date.now() + 2000;
      confirmTrustAt = Date.now() + 3000;
    }
    if (text.includes('Version:') && (text.includes('Loginmethod:') || text.includes('Account:'))) statusSeen = true;
  });
  const deadline = Date.now() + (dependencies.timeoutMs ?? 20000);
  try {
    while (!exited && Date.now() < deadline && outputSize <= 512 * 1024) {
      if (selectTrustAt !== null && Date.now() >= selectTrustAt) { if (trustNeedsDown) child.write('\x1b[B'); selectTrustAt = null; }
      if (confirmTrustAt !== null && Date.now() >= confirmTrustAt) { child.write('\r'); confirmTrustAt = null; }
      if (fresh(await read(), now()) && statusSeen) return;
      await delay(Math.min(200, Math.max(1, deadline - Date.now())));
    }
    // Credential persistence can finish just as the probe exits.
    if (fresh(await read(), now()) && statusSeen) return;
    throw failure();
  } finally {
    terminate('SIGTERM');
    for (let i = 0; i < 10 && !exited; i++) await delay(50);
    terminate('SIGKILL');
    for (let i = 0; i < 10 && !exited; i++) await delay(50);
    dataListener.dispose(); exitListener.dispose();
    process.removeListener('exit', onParentExit);
  }
}
