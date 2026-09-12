import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locate, check, apply, rollback, ROOT, sha, patchedManifest } from '../patch.mjs';
const target = locate(process.env.PASEO_PATCH_TEST_CLI);
const base = 'dist/server/services/quota-fetcher';

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
