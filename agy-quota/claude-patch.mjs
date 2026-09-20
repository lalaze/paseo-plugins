#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { locate, ROOT, sha } from './patch.mjs';

const BASE = 'dist/server/services/quota-fetcher/providers';
const HELPER = 'claude-quota-throttle.js';
const PREFIX = `// paseo-agy-quote:claude-throttle\nimport { createClaudeQuotaFetch } from "./${HELPER}";\n`;
const ANCHOR = '        this.fetchApi = options.fetch ?? fetch;';
const REPLACEMENT = '        this.fetchApi = createClaudeQuotaFetch(options.fetch ?? fetch, options.quotaFetchOptions);';
const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const statePath = target => join(ROOT, '.state', `claude-${sha(target.server).slice(0, 20)}.json`);
const atomic = (path, contents) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, path);
};

export function patchedClaude(original) {
  if (original.includes(PREFIX) || original.split(ANCHOR).length !== 2) throw new Error('Claude provider changed; refuse blind patch');
  return PREFIX + original.replace(ANCHOR, REPLACEMENT);
}

export function unpatchedClaude(contents) {
  if (!contents.startsWith(PREFIX) || contents.split(REPLACEMENT).length !== 2) throw new Error('Claude provider is not this patch');
  return contents.slice(PREFIX.length).replace(REPLACEMENT, ANCHOR);
}

export function checkClaude(target) {
  const baseline = json(join(ROOT, 'compatibility.json'));
  const contents = read(join(target.server, BASE, 'claude.js'));
  const installed = contents.startsWith(PREFIX);
  const original = installed ? unpatchedClaude(contents) : contents;
  if (sha(original) !== baseline.claudeFileSha256) throw new Error('Incompatible Claude provider; no files written');
  const helperPath = join(target.server, BASE, HELPER);
  const expectedHelper = sha(read(join(ROOT, 'src', HELPER)));
  const helperHash = existsSync(helperPath) ? sha(read(helperPath)) : null;
  if (installed) {
    if (!existsSync(statePath(target))) throw new Error('Claude backup missing; refuse modification');
    const state = json(statePath(target));
    if (state.server !== target.server || sha(contents) !== state.afterHash || sha(state.before) !== state.beforeHash || state.before !== original) throw new Error('Claude installation or backup changed');
    if (!helperHash || (helperHash !== state.helperHash && helperHash !== expectedHelper)) throw new Error('Claude helper missing or modified');
  } else {
    patchedClaude(original);
    if (helperHash && helperHash !== expectedHelper) throw new Error('Unmanaged Claude helper; refuse overwrite');
  }
  return { installed, helperStale: installed && helperHash !== expectedHelper, paseoVersion: target.version, intervalMinutes: 15 };
}

export function applyClaude(target, { runTests = true } = {}) {
  const result = checkClaude(target);
  if (result.installed && !result.helperStale) return 'Claude quota throttle already applied.';
  if (runTests) execFileSync(process.execPath, ['--test', join(ROOT, 'test/claude.test.mjs')], { stdio: 'inherit', env: { ...process.env, PASEO_PATCH_TEST_CLI: target.cli } });
  checkClaude(target);
  const file = join(target.server, BASE, 'claude.js');
  const helper = read(join(ROOT, 'src', HELPER));
  const before = result.installed ? unpatchedClaude(read(file)) : read(file);
  const after = patchedClaude(before);
  mkdirSync(join(ROOT, '.state'), { recursive: true, mode: 0o700 });
  if (existsSync(statePath(target))) cpSync(statePath(target), `${statePath(target)}.${Date.now()}.bak`);
  atomic(statePath(target), JSON.stringify({ server: target.server, before, beforeHash: sha(before), afterHash: sha(after), helperHash: sha(helper) }, null, 2) + '\n');
  atomic(join(target.server, BASE, HELPER), helper);
  atomic(file, after);
  checkClaude(target);
  return 'Claude quota throttle applied (15 minutes; honors Retry-After). Restart Paseo to activate.';
}

export function rollbackClaude(target) {
  checkClaude(target);
  const state = json(statePath(target));
  if (sha(read(join(target.server, BASE, HELPER))) !== state.helperHash) throw new Error('Claude helper changed; refusing rollback');
  atomic(join(target.server, BASE, 'claude.js'), state.before);
  unlinkSync(join(target.server, BASE, HELPER));
  return 'Claude quota throttle rolled back. Restart Paseo to activate.';
}

export function claudeFixture(target) {
  const dir = mkdtempSync(join(tmpdir(), 'paseo-claude-test-'));
  let original = read(join(target.server, BASE, 'claude.js'));
  if (original.startsWith(PREFIX)) original = unpatchedClaude(original);
  if (sha(original) !== json(join(ROOT, 'compatibility.json')).claudeFileSha256) throw new Error('Incompatible Claude fixture source');
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  mkdirSync(join(dir, 'providers'));
  writeFileSync(join(dir, 'providers/claude.js'), patchedClaude(original));
  cpSync(join(ROOT, 'src', HELPER), join(dir, 'providers', HELPER));
  symlinkSync(join(target.server, BASE, '../usage.js'), join(dir, 'usage.js'));
  symlinkSync(join(target.cli, 'node_modules'), join(dir, 'node_modules'));
  return { dir, module: pathToFileURL(join(dir, 'providers/claude.js')).href, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (!['check', 'apply', 'rollback'].includes(command) || (args.length && (args.length !== 2 || args[0] !== '--cli'))) throw new Error('Usage: node claude-patch.mjs check|apply|rollback [--cli /path/to/@getpaseo/cli]');
    const target = locate(args[1]);
    console.log(command === 'check' ? JSON.stringify(checkClaude(target), null, 2) : command === 'apply' ? applyClaude(target) : rollbackClaude(target));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
