#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, renameSync, unlinkSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { locate, ROOT, sha } from './patch.mjs';
import { needsKimiRefresh, renewWithKimi } from './src/kimi-refresh.js';
const BASE = 'dist/server/services/quota-fetcher/providers';
const MARK = '// paseo-agy-quote:kimi-refresh';
const read = p => readFileSync(p, 'utf8');
const json = p => JSON.parse(read(p));
const atomic = (p, text) => { const t = `${p}.${process.pid}.tmp`; writeFileSync(t, text, { mode: 0o600 }); renameSync(t, p); };
const statePath = t => join(ROOT, '.state', `kimi-${sha(t.server).slice(0, 20)}.json`);

export function patchedKimi(original) {
  const anchor = '                return { ...credentials, access_token: credentials.access_token };';
  if (original.includes(MARK) || original.split(anchor).length !== 2) throw new Error('Kimi provider changed; refuse blind patch');
  return `${MARK}\nimport { ensureKimiCredentialsFresh } from "./kimi-refresh.js";\n` + original.replace(anchor, `                await ensureKimiCredentialsFresh(path, credentials);\n                const refreshed = await this.readCredentialFile(path);\n                if (!refreshed?.access_token) return null;\n                return { ...refreshed, access_token: refreshed.access_token };`);
}
export function checkKimi(target) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('Linux or macOS required');
  const baseline = json(join(ROOT, 'compatibility.json'));
  const shared = 'dist/server/services/quota-fetcher/usage.js';
  if (sha(read(join(target.server, shared))) !== baseline.serverFiles[shared]) throw new Error('Shared quota helpers changed; review compatibility');
  const file = join(target.server, BASE, 'kimi.js');
  const contents = read(file);
  const installed = contents.startsWith(MARK + '\n');
  const state = installed ? json(statePath(target)) : null;
  if (installed && (state.server !== target.server || sha(contents) !== state.afterHash || sha(state.before) !== state.beforeHash)) throw new Error('Kimi installation or backup changed');
  if (sha(installed ? state.before : contents) !== baseline.kimiFileSha256) throw new Error('Incompatible upstream Kimi provider; no files written');
  const helper = join(target.server, BASE, 'kimi-refresh.js');
  const expectedHelper = sha(read(join(ROOT, 'src/kimi-refresh.js')));
  const helperHash = existsSync(helper) ? sha(read(helper)) : null;
  if (installed) {
    if (!helperHash || (helperHash !== state.helperHash && helperHash !== expectedHelper)) throw new Error('Kimi helper missing or modified');
  } else if (helperHash && helperHash !== expectedHelper) {
    throw new Error('Kimi refresh helper changed; review before applying');
  }
  if (!installed) patchedKimi(contents);
  return { installed, helperStale: Boolean(installed && helperHash && helperHash !== expectedHelper), paseoVersion: target.version, testedKimiVersion: baseline.testedKimiVersion };
}
export function applyKimi(target, { runTests = true } = {}) {
  const result = checkKimi(target);
  const helper = read(join(ROOT, 'src/kimi-refresh.js'));
  const helperPath = join(target.server, BASE, 'kimi-refresh.js');
  if (result.installed && existsSync(helperPath) && sha(read(helperPath)) === sha(helper)) return 'Kimi renewal already applied.';
  if (runTests) execFileSync(process.execPath, ['--test', join(ROOT, 'test/kimi.test.mjs')], { stdio: 'inherit', env: { ...process.env, PASEO_PATCH_TEST_CLI: target.cli } });
  checkKimi(target);
  mkdirSync(join(ROOT, '.state'), { recursive: true, mode: 0o700 });
  if (existsSync(statePath(target))) cpSync(statePath(target), `${statePath(target)}.${Date.now()}.bak`);
  if (result.installed) {
    const state = json(statePath(target));
    atomic(helperPath, helper);
    atomic(statePath(target), JSON.stringify({ ...state, helperHash: sha(helper), appliedAt: new Date().toISOString() }, null, 2) + '\n');
    checkKimi(target);
    return 'Kimi renewal helper updated. Restart Paseo to activate.';
  }
  const file = join(target.server, BASE, 'kimi.js');
  const before = read(file);
  const after = patchedKimi(before);
  atomic(statePath(target), JSON.stringify({ server: target.server, before, beforeHash: sha(before), afterHash: sha(after), helperHash: sha(helper), appliedAt: new Date().toISOString() }, null, 2));
  atomic(helperPath, helper);
  atomic(file, after);
  checkKimi(target);
  return 'Kimi renewal applied with independent backup. Restart Paseo to activate.';
}
export function rollbackKimi(target) {
  const state = json(statePath(target));
  const file = join(target.server, BASE, 'kimi.js');
  const helper = join(target.server, BASE, 'kimi-refresh.js');
  if (state.server !== target.server || sha(read(file)) !== state.afterHash || sha(state.before) !== state.beforeHash || sha(read(helper)) !== state.helperHash) throw new Error('Kimi files changed; refusing rollback');
  atomic(file, state.before);
  unlinkSync(helper);
  return 'Kimi renewal rolled back; Google quota patch unchanged. Restart Paseo to activate.';
}
export function kimiFixture(target) {
  const dir = mkdtempSync(join(tmpdir(), 'paseo-kimi-test-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  mkdirSync(join(dir, 'providers'));
  let original = read(join(target.server, BASE, 'kimi.js'));
  if (original.startsWith(MARK + '\n')) original = json(statePath(target)).before;
  writeFileSync(join(dir, 'providers/kimi.js'), patchedKimi(original));
  cpSync(join(ROOT, 'src/kimi-refresh.js'), join(dir, 'providers/kimi-refresh.js'));
  symlinkSync(join(target.server, BASE, '../usage.js'), join(dir, 'usage.js'));
  symlinkSync(join(target.cli, 'node_modules'), join(dir, 'node_modules'));
  return { dir, module: pathToFileURL(join(dir, 'providers/kimi.js')).href, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['check', 'apply', 'rollback', 'live'].includes(command) || (args.length && (args.length !== 2 || args[0] !== '--cli'))) throw new Error('Usage: node kimi-patch.mjs check|apply|rollback|live [--cli /path/to/@getpaseo/cli]');
  const target = locate(args[1]);
  if (command === 'check') console.log(JSON.stringify(checkKimi(target), null, 2));
  if (command === 'apply') console.log(applyKimi(target));
  if (command === 'rollback') console.log(rollbackKimi(target));
  if (command === 'live') {
    checkKimi(target);
    const home = homedir();
    const credentialFiles = [
      join(process.env.KIMI_CODE_HOME || join(home, '.kimi-code'), 'credentials', 'kimi-code.json'),
      join(home, '.kimi', 'credentials', 'kimi-code.json'),
    ];
    console.error(`live: PASEO_KIMI_BIN=${process.env.PASEO_KIMI_BIN || 'unset'} KIMI_TOKEN=${process.env.KIMI_TOKEN ? 'set' : 'unset'} KIMI_API_KEY=${process.env.KIMI_API_KEY ? 'set' : 'unset'}`);
    for (const path of credentialFiles) {
      if (!existsSync(path)) {
        console.error(`live: credentials missing ${path}`);
        continue;
      }
      try {
        const credentials = json(path);
        const remainingMs = typeof credentials.expires_at === 'number' && Number.isFinite(credentials.expires_at)
          ? credentials.expires_at * 1000 - Date.now() : null;
        console.error(`live: credentials ${path} access_token=${credentials.access_token ? 'yes' : 'no'} refresh_token=${credentials.refresh_token ? 'yes' : 'no'} expires_in_min=${remainingMs == null ? 'n/a' : Math.round(remainingMs / 60000)}`);
        if (needsKimiRefresh(credentials)) {
          console.error(`live: refreshing ${path}`);
          try {
            await renewWithKimi(path, {
              stdio: ['ignore', 'pipe', 'pipe'],
              trace: line => console.error(`live: ${line}`),
            });
            console.error('live: refresh finished');
          } catch (error) {
            console.error(`live: refresh failed ${error.message}`);
          }
        }
      } catch {
        console.error(`live: credentials unreadable ${path}`);
      }
    }
    const fixture = kimiFixture(target);
    try {
      const { KimiQuotaProvider } = await import(fixture.module);
      const result = await new KimiQuotaProvider({
        logger: { child() { return this; }, debug(...args) { console.error(`live: ${args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}`); } },
        fetch: async (url, init) => {
          try {
            const res = await fetch(url, init);
            console.error(`live: usage API ${res.status}`);
            return res;
          } catch (error) {
            console.error(`live: usage API failed ${error.message}`);
            throw error;
          }
        },
      }).fetchUsage();
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'available') process.exitCode = 1;
    } finally { fixture.cleanup(); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
