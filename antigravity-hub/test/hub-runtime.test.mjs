import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc, stopHub } from '../src/hub/runtime.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('Hub start failure is retried instead of sticking to the first rejection', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-runtime-'));
  const fail = join(dir, 'fail-hub');
  const ok = join(dir, 'ok-hub');
  writeFileSync(fail, '#!/usr/bin/env node\nprocess.exit(1);\n');
  chmodSync(fail, 0o700);
  copyFileSync(join(ROOT, 'test/fixtures/hub-server.mjs'), ok);
  chmodSync(ok, 0o700);
  writeFileSync(join(dir, 'rpc.jsonl'), '');
  const previous = process.env.AGY_HUB_BIN;
  process.env.AGY_HUB_BIN = fail;
  process.env.HUB_FIXTURE_LOG = join(dir, 'rpc.jsonl');
  try {
    await assert.rejects(() => rpc('GetCascadeModelConfigData', {}), /Hub exited/);
    process.env.AGY_HUB_BIN = ok;
    const data = await rpc('GetCascadeModelConfigData', {});
    assert.equal(data.clientModelConfigs[0].modelId, 'test-model');
    await stopHub();
    const again = await rpc('GetCascadeModelConfigData', {});
    assert.equal(again.clientModelConfigs[0].modelId, 'test-model');
  } finally {
    await stopHub();
    if (previous === undefined) delete process.env.AGY_HUB_BIN;
    else process.env.AGY_HUB_BIN = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
