import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locate, check, apply, rollback, recover, ROOT, sha, patchedManifest } from '../patch.mjs';
const target = locate(process.env.PASEO_PATCH_TEST_CLI);
const base = 'dist/server/services/quota-fetcher';

test('CLI discovery supports official and fork packages with canonical dependency aliases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paseo-cli-discovery-'));
  const previousPath = process.env.PATH;
  try {
    for (const name of ['@getpaseo/cli', '@lalaze/paseo-cli']) {
      const cli = join(dir, name);
      const server = join(cli, 'node_modules/@getpaseo/server');
      mkdirSync(join(server, 'dist'), { recursive: true });
      mkdirSync(join(cli, 'bin'));
      writeFileSync(join(cli, 'package.json'), JSON.stringify({ name }));
      writeFileSync(join(cli, 'bin/paseo'), '');
      writeFileSync(join(server, 'package.json'), JSON.stringify({ name: name === '@getpaseo/cli' ? '@getpaseo/server' : '@lalaze/paseo-server', version: '0.9.0-beta.2.lalaze.1', exports: './dist/index.js' }));
      writeFileSync(join(server, 'dist/index.js'), '');
      assert.equal(locate(cli).server, realpathSync(server));
      const wrapper = join(dir, 'wrapper');
      mkdirSync(wrapper, { recursive: true });
      writeFileSync(join(wrapper, 'paseo'), '');
      process.env.PATH = `${wrapper}:${join(cli, 'bin')}`;
      assert.equal(locate().cli, realpathSync(cli));
      const linked = join(dir, name.replaceAll('/', '-'));
      mkdirSync(linked);
      symlinkSync(join(cli, 'bin/paseo'), join(linked, 'paseo'));
      process.env.PATH = `${wrapper}:${linked}`;
      assert.equal(locate().cli, realpathSync(cli));
    }
    const unrelated = join(dir, 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'package.json'), JSON.stringify({ name: '@someone/cli' }));
    assert.throws(() => locate(unrelated), /Not a Paseo CLI package/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upstream Antigravity and ambiguous manifests are refused', () => {
  assert.throws(() => patchedManifest('Antigravity upstream'), /already exists/);
  assert.throws(() => patchedManifest(''), /anchor/);
});
test('apply is idempotent, rollback exact, drift refused without mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paseo-patch-install-test-'));
  const t = { ...target, server: dir };
  const state = join(ROOT, '.state', `${sha(dir).slice(0, 20)}.json`);
  try {
    mkdirSync(join(dir, base, 'providers'), { recursive: true });
    const compatible = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'));
    for (const relative of Object.keys(compatible.serverFiles)) cpSync(join(target.server, relative), join(dir, relative));
    // Tests also work after the real install has been patched.
    const manifest = join(dir, base, 'manifest.js');
    if (readFileSync(manifest, 'utf8').startsWith('// paseo-agy-quote:managed')) {
      const liveState = JSON.parse(readFileSync(join(ROOT, '.state', `${sha(target.server).slice(0, 20)}.json`), 'utf8'));
      writeFileSync(manifest, liveState.before);
    }
    const before = readFileSync(manifest, 'utf8');
    assert.equal(check(t).installed, false);
    apply(t, { runTests: false });
    assert.equal(check(t).installed, true);
    assert.match(apply(t, { runTests: false }), /Already/);
    const patched = readFileSync(manifest, 'utf8');
    writeFileSync(manifest, patched + '\n// unrelated edit');
    assert.throws(() => rollback(t), /refusing rollback/);
    assert.equal(readFileSync(manifest, 'utf8'), patched + '\n// unrelated edit');
    writeFileSync(manifest, patched);
    rollback(t);
    assert.equal(readFileSync(manifest, 'utf8'), before);
    assert.equal(existsSync(join(dir, base, 'providers/antigravity.js')), false);
    writeFileSync(join(dir, base, 'usage.js'), '// changed upstream');
    assert.throws(() => apply(t, { runTests: false }), /Incompatible/);
    assert.equal(readFileSync(manifest, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(state, { force: true }); }
});
test('recover restores vanilla files when .state is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paseo-patch-recover-test-'));
  const t = { ...target, server: dir };
  const state = join(ROOT, '.state', `${sha(dir).slice(0, 20)}.json`);
  try {
    mkdirSync(join(dir, base, 'providers'), { recursive: true });
    const compatible = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'));
    for (const relative of Object.keys(compatible.serverFiles)) cpSync(join(target.server, relative), join(dir, relative));
    const manifest = join(dir, base, 'manifest.js');
    if (readFileSync(manifest, 'utf8').startsWith('// paseo-agy-quote:managed')) {
      const liveState = JSON.parse(readFileSync(join(ROOT, '.state', `${sha(target.server).slice(0, 20)}.json`), 'utf8'));
      writeFileSync(manifest, liveState.before);
    }
    const before = readFileSync(manifest, 'utf8');
    apply(t, { runTests: false });
    rmSync(state, { force: true });
    assert.throws(() => check(t), /run node patch.mjs recover/);
    assert.match(recover(t), /Recovered vanilla/);
    assert.equal(readFileSync(manifest, 'utf8'), before);
    assert.equal(existsSync(join(dir, base, 'providers/antigravity.js')), false);
    assert.equal(check(t).installed, false);
    assert.match(recover(t), /already vanilla/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(state, { force: true }); }
});
