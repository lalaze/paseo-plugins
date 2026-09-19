import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUARD = join(ROOT, 'bin/paseo');

function fixture({ googlePatchExit = 0, kimiPatchExit = 0, grokPatchExit = 0, directorPatchExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'paseo-kimi-guard-'));
  const pathDir = join(dir, 'path');
  const cliDir = join(dir, 'cli');
  const realBin = join(cliDir, 'bin');
  const real = join(realBin, 'paseo');
  const googlePatch = join(dir, 'google-patch.mjs');
  const kimiPatch = join(dir, 'kimi-patch.mjs');
  const grokPatch = join(dir, 'grok-patch.mjs');
  const directorPatch = join(dir, 'director-patch.mjs');
  const realLog = join(dir, 'real.log');
  const patchLog = join(dir, 'patch.log');
  const guard = join(dir, 'bin/paseo');
  mkdirSync(join(dir, 'bin'));
  cpSync(GUARD, guard); // Isolate optional sibling patches from the developer's checkout.
  mkdirSync(pathDir);
  mkdirSync(realBin, { recursive: true });
  writeFileSync(real, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$GUARD_REAL_LOG"\n');
  chmodSync(real, 0o755);
  symlinkSync(real, join(pathDir, 'paseo'));
  writeFileSync(googlePatch, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.GUARD_PATCH_LOG, 'google\\n' + process.argv.slice(2).join('\\n') + '\\n');\nprocess.exit(${googlePatchExit});\n`);
  writeFileSync(kimiPatch, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.GUARD_PATCH_LOG, 'kimi\\n' + process.argv.slice(2).join('\\n') + '\\n');\nprocess.exit(${kimiPatchExit});\n`);
  writeFileSync(grokPatch, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.GUARD_PATCH_LOG, 'grok\\n' + process.argv.slice(2).join('\\n') + '\\n');\nprocess.exit(${grokPatchExit});\n`);
  writeFileSync(directorPatch, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.GUARD_PATCH_LOG, 'director\\n' + process.argv.slice(2).join('\\n') + '\\n');\nprocess.exit(${directorPatchExit});\n`);
  const env = {
    ...process.env,
    PATH: `${pathDir}:${process.env.PATH}`,
    PASEO_USAGE_GUARD_GOOGLE_PATCH_SCRIPT: googlePatch,
    PASEO_USAGE_GUARD_KIMI_PATCH_SCRIPT: kimiPatch,
    PASEO_USAGE_GUARD_GROK_PATCH_SCRIPT: grokPatch,
    PASEO_USAGE_GUARD_DIRECTOR_PATCH_SCRIPT: directorPatch,
    GUARD_REAL_LOG: realLog,
    GUARD_PATCH_LOG: patchLog,
  };
  return { dir, guard, cliDir: realpathSync(cliDir), env, realLog, patchLog, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('ordinary Paseo commands bypass the patch guard', () => {
  const f = fixture();
  try {
    const result = spawnSync(f.guard, ['--version'], { env: f.env });
    assert.equal(result.status, 0);
    assert.equal(readFileSync(f.realLog, 'utf8'), '--version\n');
    assert.equal(existsSync(f.patchLog), false);
  } finally {
    f.cleanup();
  }
});

test('restart reapplies quota and Director notification patches before launching Paseo', () => {
  const f = fixture();
  try {
    const result = spawnSync(f.guard, ['daemon', 'restart', '--json'], { env: f.env });
    assert.equal(result.status, 0);
    assert.equal(readFileSync(f.patchLog, 'utf8'), `google\napply\n--cli\n${f.cliDir}\nkimi\napply\n--cli\n${f.cliDir}\ngrok\napply\n--cli\n${f.cliDir}\ndirector\napply\n--cli\n${f.cliDir}\n`);
    assert.equal(readFileSync(f.realLog, 'utf8'), 'daemon\nrestart\n--json\n');
  } finally {
    f.cleanup();
  }
});

test('an incompatible Google patch blocks restart without invoking Paseo', () => {
  const f = fixture({ googlePatchExit: 42 });
  try {
    const result = spawnSync(f.guard, ['restart'], { env: f.env });
    assert.equal(result.status, 42);
    assert.equal(existsSync(f.realLog), false);
  } finally {
    f.cleanup();
  }
});

test('an incompatible Kimi patch blocks restart without invoking Paseo', () => {
  const f = fixture({ kimiPatchExit: 43 });
  try {
    const result = spawnSync(f.guard, ['restart'], { env: f.env });
    assert.equal(result.status, 43);
    assert.equal(existsSync(f.realLog), false);
  } finally {
    f.cleanup();
  }
});

test('an incompatible Grok patch blocks restart without invoking Paseo', () => {
  const f = fixture({ grokPatchExit: 45 });
  try {
    const result = spawnSync(f.guard, ['restart'], { env: f.env });
    assert.equal(result.status, 45);
    assert.equal(existsSync(f.realLog), false);
  } finally { f.cleanup(); }
});


test('an incompatible Director notification patch blocks restart before launching Paseo', () => {
  const f = fixture({ directorPatchExit: 44 });
  try {
    const result = spawnSync(f.guard, ['restart'], { env: f.env });
    assert.equal(result.status, 44);
    assert.equal(existsSync(f.realLog), false);
  } finally { f.cleanup(); }
});
