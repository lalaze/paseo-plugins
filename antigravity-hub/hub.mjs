#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const PROVIDER_ID = 'antigravity-hub';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function atomic(path, data, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode, flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function locations({ paseoHome = process.env.PASEO_HOME || join(homedir(), '.paseo'), root = ROOT, binary } = {}) {
  const home = resolve(paseoHome);
  return {
    root,
    config: join(home, 'config.json'),
    state: join(root, '.state', `hub-${fingerprint(home).slice(0, 20)}.json`),
    entry: join(root, 'hub.mjs'),
    binary: binary || process.env.AGY_HUB_BIN || join(homedir(), '.gemini/bin/agy'),
  };
}

function provider(target) {
  return {
    extends: 'acp',
    label: 'Antigravity Hub (Preview)',
    description: 'Local agy Hub bridge with images, session MCP servers and interactive ACP approvals',
    command: [process.execPath, target.entry, 'run'],
    env: { AGY_HUB_BIN: target.binary },
    params: { supportsMcpServers: true },
    enabled: true,
  };
}

function snapshot(target) {
  const config = read(target.config);
  if (!config.agents?.providers || Array.isArray(config.agents.providers) || typeof config.agents.providers !== 'object') {
    throw new Error('Paseo config has no agents.providers object; no changes written.');
  }
  const current = config.agents.providers[PROVIDER_ID] ?? null;
  const state = existsSync(target.state) ? read(target.state) : null;
  if (state && (state.config !== target.config || fingerprint(state.before) !== state.beforeHash || fingerprint(state.after) !== state.afterHash)) {
    throw new Error('Hub backup state changed; refusing mutation.');
  }
  return { config, current, state };
}

export function checkHub(target = locations()) {
  const { current, state } = snapshot(target);
  const currentHash = fingerprint(current);
  return {
    providerId: PROVIDER_ID,
    installed: !!state && current != null && currentHash === state.afterHash,
    needsUpdate: !!state && current != null && currentHash === state.afterHash && fingerprint(provider(target)) !== state.afterHash,
    drifted: !!state && currentHash !== state.afterHash && currentHash !== state.beforeHash,
    configuredCommand: current?.command ?? null,
    expectedCommand: provider(target).command,
    binaryExists: existsSync(target.binary),
    config: target.config,
  };
}

/** Update only this provider; never restore an entire config over unrelated edits. */
export function installHub(target = locations(), { replaceExisting = false } = {}) {
  if (!existsSync(target.binary) || !statSync(target.binary).isFile()) throw new Error('AGY_HUB_BIN must point to an installed agy binary.');
  const { config, current, state } = snapshot(target);
  const after = provider(target);
  const currentHash = fingerprint(current);
  if (state && current && currentHash === state.afterHash) {
    if (fingerprint(after) === state.afterHash) return 'Already installed; no changes.';
    if (fingerprint(after.command) !== fingerprint(current.command) || fingerprint(after.env) !== fingerprint(current.env)) throw new Error('Managed launch settings changed; rollback before installing with different paths.');
  }
  if (state && currentHash !== state.beforeHash && currentHash !== state.afterHash && currentHash !== fingerprint(after)) {
    throw new Error('Hub provider changed since installation; refusing overwrite.');
  }
  if (!state && current && !replaceExisting && currentHash !== fingerprint(after)) {
    throw new Error('Existing antigravity-hub entry; use --replace-existing to migrate it with a backup.');
  }
  const backup = { config: target.config, before: state ? state.before : current, beforeHash: state ? state.beforeHash : currentHash, after, afterHash: fingerprint(after) };
  const hadState = existsSync(target.state);
  const previousState = hadState ? read(target.state) : null;
  mkdirSync(dirname(target.state), { recursive: true, mode: 0o700 });
  const restore = () => {
    if (hadState) atomic(target.state, previousState);
    else if (existsSync(target.state)) unlinkSync(target.state);
  };
  try {
    // Record the rollback target first, but keep afterHash on the currently installed
    // provider until config is committed so a crash cannot deadlock rollback.
    atomic(target.state, { ...backup, after: state ? state.after : current, afterHash: state ? state.afterHash : currentHash });
    const latest = read(target.config);
    if (fingerprint(latest) !== fingerprint(config)) throw new Error('Paseo config changed during install; retry after reviewing it.');
    latest.agents.providers[PROVIDER_ID] = after;
    atomic(target.config, latest, statSync(target.config).mode & 0o777);
    atomic(target.state, backup);
  } catch (error) {
    try { restore(); } catch {}
    throw error;
  }
  return 'Hub provider installed. Run paseo reload to activate. Backup retained in .state/.';
}

export function rollbackHub(target = locations()) {
  const { config, current, state } = snapshot(target);
  if (!state) throw new Error('No Hub installation backup.');
  if (fingerprint(current) === state.beforeHash) return 'Already rolled back; no changes.';
  if (fingerprint(current) !== state.afterHash) throw new Error('Hub provider changed; refusing rollback over unrelated edits.');
  if (state.before === null) delete config.agents.providers[PROVIDER_ID];
  else config.agents.providers[PROVIDER_ID] = state.before;
  atomic(target.config, config, statSync(target.config).mode & 0o777);
  return 'Hub provider rolled back. Run paseo reload to activate. Backup retained.';
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'run' && args.length === 0) { await import('./src/hub/acp.mjs'); return; }
  if (command === '--version') { console.log('agy-hub-acp 0.3.0'); return; }
  if (!['check', 'install', 'rollback'].includes(command) || args.some(arg => arg !== '--replace-existing') || (args.length && command !== 'install')) {
    throw new Error('Usage: node hub.mjs run|check|install [--replace-existing]|rollback; AGY_HUB_BIN and PASEO_HOME override paths.');
  }
  const target = locations();
  if (command === 'check') console.log(JSON.stringify(checkHub(target), null, 2));
  if (command === 'install') console.log(installHub(target, { replaceExisting: args.includes('--replace-existing') }));
  if (command === 'rollback') console.log(rollbackHub(target));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
