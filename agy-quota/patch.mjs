#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, renameSync, unlinkSync, mkdtempSync, cpSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

export const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE = 'dist/server/services/quota-fetcher';
const MARK = '// paseo-agy-quote:managed';
const FILES = ['antigravity.js', 'antigravity-local.js'];
export const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const read = path => readFileSync(path, 'utf8');
const atomic = (path, text) => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path); };

export function locate(cliOverride) {
  let cli = cliOverride && resolve(cliOverride);
  if (!cli) {
    const candidates = (process.env.PATH || '')
      .split(delimiter)
      .map(p => join(p, 'paseo'))
      .filter(existsSync);
    for (const executable of candidates) {
      const candidate = dirname(dirname(realpathSync(executable)));
      try {
        if (json(join(candidate, 'package.json')).name === '@getpaseo/cli') {
          cli = candidate;
          break;
        }
      } catch {
        // PATH may intentionally contain a stable wrapper before the npm CLI.
      }
    }
    if (!cli) throw new Error('Paseo CLI package not found on PATH; pass --cli /absolute/path/to/@getpaseo/cli');
  }
  if (json(join(cli, 'package.json')).name !== '@getpaseo/cli') throw new Error('Not a Paseo CLI package');
  const req = createRequire(join(cli, 'package.json'));
  let server = dirname(req.resolve('@getpaseo/server'));
  while (!existsSync(join(server, 'package.json'))) {
    const parent = dirname(server);
    if (parent === server) throw new Error('Cannot find Paseo server package');
    server = parent;
  }
  return { cli, server, req, version: json(join(server, 'package.json')).version };
}

export function patchedManifest(original) {
  if (/antigravity/i.test(original)) throw new Error('Antigravity registration already exists; inspect upstream support first');
  const anchor = 'export const PROVIDER_USAGE_FETCHERS = [';
  if (original.split(anchor).length !== 2) throw new Error('Manifest anchor changed');
  return `${MARK}\nimport { AntigravityQuotaProvider } from "./providers/antigravity.js";\n` + original.replace(anchor, `${anchor}\n    {\n        providerId: "antigravity-acp",\n        create: (options) => new AntigravityQuotaProvider({ logger: options.logger }),\n    },`);
}

function statePath(target) { return join(ROOT, '.state', `${sha(target.server).slice(0, 20)}.json`); }
function expectedPayload() { return Object.fromEntries(FILES.map(f => [f, sha(read(join(ROOT, 'src', f)))])); }

export function check(target) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('This patch supports Linux and macOS only');
  const baseline = json(join(ROOT, 'compatibility.json'));
  const manifest = read(join(target.server, BASE, 'manifest.js'));
  const installed = manifest.startsWith(MARK + '\n');
  let state;
  if (installed) {
    if (!existsSync(statePath(target))) throw new Error('Managed manifest without backup state; refusing mutation');
    state = json(statePath(target));
    if (state.server !== target.server || sha(manifest) !== state.afterHash || sha(state.before) !== state.beforeHash) throw new Error('Installed manifest or backup was modified');
  }
  for (const [relative, hash] of Object.entries(baseline.serverFiles)) {
    const contents = installed && relative === `${BASE}/manifest.js` ? state.before : read(join(target.server, relative));
    if (sha(contents) !== hash) throw new Error(`Incompatible Paseo ${target.version}: ${relative} changed. Review/adapt the patch; no files written.`);
  }
  const protocol = read(target.req.resolve('@getpaseo/protocol/messages'));
  const start = protocol.indexOf('export const ProviderUsageToneSchema');
  const end = protocol.indexOf('const AgentSlashCommandSchema', start);
  if (start < 0 || end < 0 || sha(protocol.slice(start, end)) !== baseline.protocolUsageSha256) throw new Error('ProviderUsage wire schema changed');
  const ptyEntry = target.req.resolve('node-pty');
  const ptyPackage = json(join(dirname(dirname(ptyEntry)), 'package.json'));
  if (ptyPackage.version !== baseline.nodePtyVersion) throw new Error('node-pty version changed; review process compatibility');
  for (const f of FILES) {
    const p = join(target.server, BASE, 'providers', f);
    if (existsSync(p) && sha(read(p)) !== expectedPayload()[f]) throw new Error(`Refusing to overwrite modified/upstream ${f}`);
    if (installed && (!existsSync(p) || sha(read(p)) !== state.payload[f])) throw new Error(`Installed ${f} missing or changed`);
  }
  if (!installed) patchedManifest(manifest);
  return { installed, version: target.version, testedVersion: baseline.testedVersion };
}

/** A disposable provider fixture resolves shared utilities/dependencies from the real install. */
export function fixture(target) {
  const dir = mkdtempSync(join(tmpdir(), 'paseo-agy-test-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  mkdirSync(join(dir, 'providers'));
  for (const f of FILES) cpSync(join(ROOT, 'src', f), join(dir, 'providers', f));
  symlinkSync(join(target.server, BASE, 'usage.js'), join(dir, 'usage.js'));
  symlinkSync(join(target.cli, 'node_modules'), join(dir, 'node_modules'));
  return { dir, module: pathToFileURL(join(dir, 'providers', 'antigravity.js')).href, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function apply(target, { runTests = true } = {}) {
  const result = check(target);
  if (result.installed) return 'Already applied; no changes.';
  const tests = readdirSync(join(ROOT, 'test')).filter(x => x.endsWith('.test.mjs')).map(x => join(ROOT, 'test', x));
  if (runTests) execFileSync(process.execPath, ['--test', ...tests], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PASEO_PATCH_TEST_CLI: target.cli } });
  check(target);
  const manifestPath = join(target.server, BASE, 'manifest.js');
  const before = read(manifestPath);
  const after = patchedManifest(before);
  const state = { server: target.server, version: target.version, before, beforeHash: sha(before), afterHash: sha(after), payload: expectedPayload(), appliedAt: new Date().toISOString() };
  mkdirSync(join(ROOT, '.state'), { recursive: true, mode: 0o700 });
  if (existsSync(statePath(target))) {
    cpSync(statePath(target), `${statePath(target)}.${Date.now()}.bak`);
  }
  atomic(statePath(target), JSON.stringify(state, null, 2) + '\n');
  // All dependencies go in first; the single manifest rename activates the patch last.
  for (const f of FILES) atomic(join(target.server, BASE, 'providers', f), read(join(ROOT, 'src', f)));
  atomic(manifestPath, after);
  check(target);
  return 'Applied with backup. Restart Paseo to activate.';
}

export function rollback(target) {
  const state = json(statePath(target));
  const manifestPath = join(target.server, BASE, 'manifest.js');
  if (state.server !== target.server || sha(read(manifestPath)) !== state.afterHash || sha(state.before) !== state.beforeHash) throw new Error('Installation changed; refusing rollback over an update or unrelated edits');
  for (const f of FILES) if (sha(read(join(target.server, BASE, 'providers', f))) !== state.payload[f]) throw new Error(`Modified ${f}; refusing rollback`);
  atomic(manifestPath, state.before);
  for (const f of FILES) unlinkSync(join(target.server, BASE, 'providers', f));
  return 'Rolled back. Restart Paseo to activate. Backup retained.';
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['check', 'apply', 'rollback', 'live'].includes(command)) throw new Error('Usage: node patch.mjs check|apply|rollback|live [--cli /path/to/@getpaseo/cli]');
  if (args.length && (args.length !== 2 || args[0] !== '--cli')) throw new Error('Unknown arguments');
  const target = locate(args[1]);
  if (command === 'check') console.log(JSON.stringify({ ...check(target), server: target.server }, null, 2));
  if (command === 'apply') console.log(apply(target));
  if (command === 'rollback') console.log(rollback(target));
  if (command === 'live') {
    check(target);
    const f = fixture(target);
    try {
      const { readLocalQuota } = await import(pathToFileURL(join(f.dir, 'providers', 'antigravity-local.js')).href);
      const { AntigravityQuotaProvider } = await import(f.module);
      const provider = new AntigravityQuotaProvider({
        logger: { child() { return this; }, debug() {} },
        readQuota: async parse => {
          try {
            return await readLocalQuota(parse, { trace: line => console.error(`live: ${line}`) });
          } catch (error) {
            console.error(`live: ${error.message}`);
            throw error;
          }
        },
      });
      const result = await provider.fetchUsage();
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'available') process.exitCode = 1;
    } finally { f.cleanup(); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
