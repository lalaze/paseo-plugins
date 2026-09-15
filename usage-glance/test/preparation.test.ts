import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, rename, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('installation makes the native package executable and survives Paseo moving its staging directory', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'paseo-prepare-test-'));
  const staging = join(root, 'staging'), installed = join(root, 'installed');
  const native = join(staging, 'node_modules', '@ccusage', `ccusage-${process.platform}-${process.arch}`);
  try {
    await mkdir(join(staging, 'scripts'), { recursive: true });
    await mkdir(join(native, 'bin'), { recursive: true });
    await writeFile(join(staging, 'package.json'), '{"type":"module"}');
    await writeFile(join(native, 'package.json'), '{}');
    // Native npm tarballs may not preserve executable permissions.
    await writeFile(join(native, 'bin', 'ccusage'), '#!/bin/sh\nprintf "fixture-ready\\n"\n', { mode: 0o600 });
    await copyFile(new URL('../scripts/prepare.mjs', import.meta.url), join(staging, 'scripts', 'prepare.mjs'));
    await exec(process.execPath, ['scripts/prepare.mjs'], { cwd: staging, env: { ...process.env, PASEO_USAGE_CACHE_DIR: join(root, 'cache') } });
    await rename(staging, installed);
    const { backend } = await import(pathToFileURL(join(installed, 'server/backend.generated.ts')).href);
    assert.equal((await exec(backend.binary)).stdout, 'fixture-ready\n');
    assert.deepEqual(JSON.parse(await readFile(backend.config, 'utf8')), {});
    assert.equal(backend.binary.startsWith(staging), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
