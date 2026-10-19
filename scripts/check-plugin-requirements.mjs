import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { locatePaseoInstallation } from './paseo-installation.mjs';

// Exercise Paseo's actual daemon/app compatibility gate, including prereleases.
// Keep an explicit wildcard: omitting requirements.paseo means pre-0.8 to Paseo.
const root = resolve(import.meta.dirname, '..');
const { server } = locatePaseoInstallation(process.argv[2]);
const require = createRequire(join(server, 'package.json'));
const { assertPluginCompatibility } = await import(
  pathToFileURL(require.resolve('@getpaseo/protocol/plugin-requirements')).href
);
const versions = ['0.8.0', '0.10.0', '0.11.1', '0.12.0-beta.1', '0.12.0', '0.13.0', '1.0.0', '99.0.0'];
let checked = 0;
for (const directory of readdirSync(root, { withFileTypes: true })) {
  if (!directory.isDirectory() || directory.name.startsWith('.')) continue;
  const path = join(root, directory.name, 'paseo-plugin.json');
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  const manifest = JSON.parse(contents);
  for (const runtime of ['daemon', 'app']) {
    for (const version of versions) {
      assertPluginCompatibility({ ...manifest, runtime, version });
    }
  }
  assert.equal(manifest.requirements?.paseo, '*', `${path}: keep an explicit unrestricted range`);
  console.log(`PASS ${manifest.id}`);
  checked++;
}
assert.ok(checked > 0, 'No plugin manifests found');
console.log(`${checked} plugins passed the daemon/app version matrix.`);
