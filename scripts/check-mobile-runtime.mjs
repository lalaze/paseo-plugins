import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Use the same dynamic evaluation boundary as Paseo, not Node's module loader.
// HERMES_BIN=/path/to/hermes node scripts/check-mobile-runtime.mjs
const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'director/package.json'));
const { build } = require('esbuild');
assert.ok(process.env.HERMES_BIN, 'Set HERMES_BIN to the Hermes CLI executable');
const probes = [
  ['director', `
    import { createLaunchRequests } from './client/launch';
    import { createDraftWriter } from './client/draft-writer';
    export function run() {
      const requests = createLaunchRequests();
      let notices = 0;
      const stop = requests.subscribe(() => notices++);
      requests.set('workspace', { status: 'setup', goal: 'test', requestId: 'request' });
      if (requests.get('workspace')?.goal !== 'test' || notices !== 1) throw Error('launch state');
      stop(); requests.clear();
      if (requests.get('workspace') !== null) throw Error('launch cleanup');
      const writer = createDraftWriter(3, input => Promise.resolve({ ...input, revision: input.revision + 1 }));
      writer.enqueue(null);
      return writer.flush().then(() => {
        if (writer.revision !== 4 || writer.busy || writer.error) throw Error('draft write');
      });
    }`],
  ['usage-glance', `
    import { createHostRegistry, getHostRegistry } from './client/hosts';
    import { createQuotaDialogController } from './client/quota-dialog';
    export function run() {
      const registry = createHostRegistry();
      let notices = 0;
      const stop = registry.subscribe(() => notices++);
      const registration = registry.register({ consumption: { client: { getQueryCache: () => ({
        subscribe: () => () => {}, findAll: () => [],
      }) } } });
      registration.identify({ id: 'phone', label: 'Phone' });
      if (!registry.get('phone')?.online || registry.getSnapshot().length !== 1 || notices !== 1) throw Error('host state');
      registration.dispose(); stop();
      if (registry.get('phone')?.online) throw Error('host cleanup');
      if (getHostRegistry() !== getHostRegistry()) throw Error('shared registry');
      const quota = createQuotaDialogController();
      const first = {}, duplicate = {};
      const remove = quota.register(first, 'workspace');
      quota.register(duplicate, 'workspace');
      quota.toggle('workspace');
      if (quota.getSnapshot()?.presenter !== first) throw Error('quota open');
      remove();
      if (quota.getSnapshot()?.presenter !== duplicate) throw Error('quota transfer');
      quota.dispose();
      if (quota.getSnapshot() !== null) throw Error('quota cleanup');
      return Promise.resolve();
    }`],
];
const directory = await mkdtemp(join(tmpdir(), 'paseo-mobile-runtime-'));
try {
  for (const [plugin, contents] of probes) {
    const result = await build({ stdin: { contents, resolveDir: join(root, plugin), loader: 'ts' }, bundle: true,
      format: 'cjs', platform: 'neutral', target: 'es2020', supported: { 'async-await': false }, write: false,
      external: ['@getpaseo/plugin', '@tanstack/react-query', 'zod', 'react'] });
    // Schema/RPC definitions are not invoked in these state lifecycle probes.
    const source = `(function(require) { const module = { exports: {} }; const exports = module.exports;
      ${result.outputFiles[0].text.replaceAll('get: () => from[key]', 'value: from[key]')}
      return module.exports; })`;
    const path = join(directory, `${plugin}.js`);
    await writeFile(path, `
      var schema = new Proxy(function() { return schema; }, { get: function() { return schema; } });
      function runtimeRequire(name) {
        if (name === 'react') return {};
        if (name === 'zod') return { z: schema };
        if (name === '@getpaseo/plugin') return { defineRpc: function(value) { return value; } };
        if (name === '@tanstack/react-query') return { isCancelledError: function() { return false; } };
        throw Error('Unexpected module ' + name);
      }
      try {
        globalThis.eval(${JSON.stringify(source)})(runtimeRequire).run().then(
          function() { print('PASS ${plugin}'); }, function(error) { print(error.stack); });
      } catch (error) { print(error.stack); }
    `);
    const execution = spawnSync(process.env.HERMES_BIN, ['-Xes6-class', path], { encoding: 'utf8' });
    assert.ifError(execution.error);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout.trim(), `PASS ${plugin}`, execution.stdout + execution.stderr);
    console.log(execution.stdout.trim());
  }
} finally { await rm(directory, { recursive: true, force: true }); }
