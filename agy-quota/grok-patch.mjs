#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, renameSync, unlinkSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { locate, ROOT, sha } from './patch.mjs';
const BASE = 'dist/server/services/quota-fetcher/providers';
const MARK = '// paseo-agy-quote:grok-refresh';
const GROK_PREFIX = `${MARK}\nimport { readFreshGrokToken } from "./grok-refresh.js";\n`;
const GROK_ANCHOR = '            return extractGrokTokenFromAuth(JSON.parse(await fs.readFile(path, "utf8")));';
const GROK_REPLACEMENT = '            return await readFreshGrokToken(path, extractGrokTokenFromAuth);';
const read = p => readFileSync(p, 'utf8');
const json = p => JSON.parse(read(p));
const atomic = (p, text) => { const t = `${p}.${process.pid}.tmp`; writeFileSync(t, text, { mode: 0o600 }); renameSync(t, p); };
const statePath = t => join(ROOT, '.state', `grok-${sha(t.server).slice(0, 20)}.json`);

export function patchedGrok(original) {
  if (original.includes(MARK) || original.split(GROK_ANCHOR).length !== 2) throw new Error('Grok provider changed; refuse blind patch');
  return GROK_PREFIX + original.replace(GROK_ANCHOR, GROK_REPLACEMENT);
}

export function unpatchedGrok(patched) {
  if (!patched.startsWith(GROK_PREFIX)) throw new Error('Grok file is not this patch; refuse recover');
  const body = patched.slice(GROK_PREFIX.length);
  if (!body.includes(GROK_REPLACEMENT)) throw new Error('Cannot reverse Grok renewal patch; refuse recover');
  return body.replace(GROK_REPLACEMENT, GROK_ANCHOR);
}
export function checkGrok(target) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('Linux or macOS required');
  const baseline = json(join(ROOT, 'compatibility.json'));
  const shared = 'dist/server/services/quota-fetcher/usage.js';
  if (sha(read(join(target.server, shared))) !== baseline.serverFiles[shared]) throw new Error('Shared quota helpers changed; review compatibility');
  const file = join(target.server, BASE, 'grok.js');
  const contents = read(file);
  const installed = contents.startsWith(MARK + '\n');
  if (installed && !existsSync(statePath(target))) throw new Error('Managed Grok without backup state; run node grok-patch.mjs recover');
  const state = installed ? json(statePath(target)) : null;
  if (installed && (state.server !== target.server || sha(contents) !== state.afterHash || sha(state.before) !== state.beforeHash)) throw new Error('Grok installation or backup changed');
  if (sha(installed ? state.before : contents) !== baseline.grokFileSha256) throw new Error('Incompatible upstream Grok provider; no files written');
  const helper = join(target.server, BASE, 'grok-refresh.js');
  const expectedHelper = sha(read(join(ROOT, 'src/grok-refresh.js')));
  const helperHash = existsSync(helper) ? sha(read(helper)) : null;
  if (installed) {
    if (!helperHash || (helperHash !== state.helperHash && helperHash !== expectedHelper)) throw new Error('Grok helper missing or modified');
  } else if (helperHash && helperHash !== expectedHelper) {
    throw new Error('Grok refresh helper changed; review before applying');
  }
  if (!installed) patchedGrok(contents);
  return { installed, helperStale: Boolean(installed && helperHash && helperHash !== expectedHelper), paseoVersion: target.version, testedGrokVersion: baseline.testedGrokVersion };
}
export function applyGrok(target, { runTests = true } = {}) {
  const result = checkGrok(target);
  const helper = read(join(ROOT, 'src/grok-refresh.js'));
  const helperPath = join(target.server, BASE, 'grok-refresh.js');
  if (result.installed && existsSync(helperPath) && sha(read(helperPath)) === sha(helper)) return 'Grok renewal already applied.';
  if (runTests) execFileSync(process.execPath, ['--test', join(ROOT, 'test/grok.test.mjs')], { stdio: 'inherit', env: { ...process.env, PASEO_PATCH_TEST_CLI: target.cli } });
  checkGrok(target);
  mkdirSync(join(ROOT, '.state'), { recursive: true, mode: 0o700 });
  if (existsSync(statePath(target))) cpSync(statePath(target), `${statePath(target)}.${Date.now()}.bak`);
  if (result.installed) {
    const state = json(statePath(target));
    atomic(helperPath, helper);
    atomic(statePath(target), JSON.stringify({ ...state, helperHash: sha(helper), appliedAt: new Date().toISOString() }, null, 2) + '\n');
    checkGrok(target);
    return 'Grok renewal helper updated. Restart Paseo to activate.';
  }
  const file = join(target.server, BASE, 'grok.js');
  const before = read(file);
  const after = patchedGrok(before);
  atomic(statePath(target), JSON.stringify({ server: target.server, before, beforeHash: sha(before), afterHash: sha(after), helperHash: sha(helper), appliedAt: new Date().toISOString() }, null, 2));
  atomic(helperPath, helper);
  atomic(file, after);
  checkGrok(target);
  return 'Grok renewal applied with independent backup. Restart Paseo to activate.';
}
export function rollbackGrok(target) {
  const state = json(statePath(target));
  const file = join(target.server, BASE, 'grok.js');
  const helper = join(target.server, BASE, 'grok-refresh.js');
  if (state.server !== target.server || sha(read(file)) !== state.afterHash || sha(state.before) !== state.beforeHash || sha(read(helper)) !== state.helperHash) throw new Error('Grok files changed; refusing rollback');
  atomic(file, state.before);
  unlinkSync(helper);
  return 'Grok renewal rolled back; other quota patches unchanged. Restart Paseo to activate.';
}
export function recoverGrok(target) {
  const file = join(target.server, BASE, 'grok.js');
  const helper = join(target.server, BASE, 'grok-refresh.js');
  const contents = read(file);
  if (!contents.startsWith(MARK + '\n')) {
    checkGrok(target);
    return 'Grok provider already vanilla; nothing to recover.';
  }
  const original = unpatchedGrok(contents);
  const baseline = json(join(ROOT, 'compatibility.json'));
  if (sha(original) !== baseline.grokFileSha256) throw new Error('Reconstructed Grok provider does not match known Paseo baseline; refuse recover');
  atomic(file, original);
  if (existsSync(helper)) unlinkSync(helper);
  checkGrok(target);
  return 'Recovered vanilla Grok provider without .state. You can now apply from this repo.';
}
export function grokFixture(target) {
  const dir = mkdtempSync(join(tmpdir(), 'paseo-grok-test-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  mkdirSync(join(dir, 'providers'));
  let original = read(join(target.server, BASE, 'grok.js'));
  if (original.startsWith(MARK + '\n')) original = unpatchedGrok(original);
  if (sha(original) !== json(join(ROOT, 'compatibility.json')).grokFileSha256) throw new Error('Incompatible Grok fixture source');
  writeFileSync(join(dir, 'providers/grok.js'), patchedGrok(original));
  cpSync(join(ROOT, 'src/grok-refresh.js'), join(dir, 'providers/grok-refresh.js'));
  symlinkSync(join(target.server, BASE, '../usage.js'), join(dir, 'usage.js'));
  symlinkSync(join(target.cli, 'node_modules'), join(dir, 'node_modules'));
  return { dir, module: pathToFileURL(join(dir, 'providers/grok.js')).href, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['check', 'apply', 'rollback', 'recover', 'live'].includes(command) || (args.length && (args.length !== 2 || args[0] !== '--cli'))) throw new Error('Usage: node grok-patch.mjs check|apply|rollback|recover|live [--cli /path/to/@getpaseo/cli]');
  const target = locate(args[1]);
  if (command === 'check') console.log(JSON.stringify(checkGrok(target), null, 2));
  if (command === 'apply') console.log(applyGrok(target));
  if (command === 'rollback') console.log(rollbackGrok(target));
  if (command === 'recover') console.log(recoverGrok(target));
  if (command === 'live') {
    checkGrok(target);
    const fixture = grokFixture(target);
    try {
      const { GrokQuotaProvider } = await import(fixture.module);
      const result = await new GrokQuotaProvider({
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
