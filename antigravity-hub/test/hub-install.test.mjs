import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locations, installHub, checkHub, rollbackHub } from '../hub.mjs';

test('Hub migration is explicit, idempotent, reversible, and preserves other providers', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-install-'));
  const home = join(root, 'paseo'); mkdirSync(home);
  const target = locations({ root, paseoHome: home, binary: process.execPath });
  const before = { extends: 'acp', command: ['node', '/previous/preview.mjs'] };
  const initial = { version: 1, agents: { providers: { 'antigravity-hub': before, 'antigravity-acp': { enabled: true } } } };
  const load = () => JSON.parse(readFileSync(target.config, 'utf8'));
  try {
    writeFileSync(target.config, JSON.stringify(initial));
    assert.throws(() => installHub(target), /Existing/);
    assert.deepEqual(load(), initial);
    installHub(target, { replaceExisting: true });
    assert.equal(checkHub(target).installed, true);
    assert.equal(checkHub(target).needsUpdate, false);
    assert.equal(load().agents.providers['antigravity-hub'].params.supportsMcpServers, true);
    assert.match(installHub(target), /Already/);
    assert.deepEqual(load().agents.providers['antigravity-acp'], initial.agents.providers['antigravity-acp']);
    const changed = load(); changed.agents.providers.unrelated = { enabled: false };
    writeFileSync(target.config, JSON.stringify(changed));
    rollbackHub(target);
    assert.deepEqual(load().agents.providers['antigravity-hub'], before);
    assert.deepEqual(load().agents.providers.unrelated, { enabled: false });
    assert.match(rollbackHub(target), /Already/);
    installHub(target);
    const drift = load(); drift.agents.providers['antigravity-hub'].label = 'User changed';
    writeFileSync(target.config, JSON.stringify(drift));
    assert.equal(checkHub(target).drifted, true);
    assert.throws(() => rollbackHub(target), /changed/);
    assert.throws(() => installHub(target), /changed/);
    assert.deepEqual(load(), drift);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Hub new install rollback removes only the added entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-install-'));
  const target = locations({ root, paseoHome: root, binary: process.execPath });
  try {
    const initial = { agents: { providers: { old: { command: ['old'] } } } };
    writeFileSync(target.config, JSON.stringify(initial));
    installHub(target); rollbackHub(target);
    assert.deepEqual(JSON.parse(readFileSync(target.config, 'utf8')), initial);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Interrupted install can retry after config commit or missing state', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-install-'));
  const target = locations({ root, paseoHome: root, binary: process.execPath });
  try {
    const original = { agents: { providers: {} } };
    writeFileSync(target.config, JSON.stringify(original));
    installHub(target);
    const state = JSON.parse(readFileSync(target.state, 'utf8'));
    writeFileSync(target.state, JSON.stringify({ ...state, after: state.before, afterHash: state.beforeHash }));
    assert.equal(checkHub(target).drifted, true);
    installHub(target);
    assert.equal(checkHub(target).installed, true);
    rollbackHub(target);
    assert.deepEqual(JSON.parse(readFileSync(target.config, 'utf8')), original);
    installHub(target);
    rmSync(target.state);
    installHub(target);
    assert.equal(checkHub(target).installed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Managed preview upgrades preserve the original rollback target', async () => {
  const { createHash } = await import('node:crypto');
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const root = mkdtempSync(join(tmpdir(), 'hub-upgrade-'));
  const target = locations({ root, paseoHome: root, binary: process.execPath });
  try {
    const original = { agents: { providers: {} } };
    writeFileSync(target.config, JSON.stringify(original)); installHub(target);
    const config = JSON.parse(readFileSync(target.config, 'utf8'));
    config.agents.providers['antigravity-hub'].params.supportsMcpServers = false;
    const state = JSON.parse(readFileSync(target.state, 'utf8'));
    state.after = config.agents.providers['antigravity-hub']; state.afterHash = hash(state.after);
    writeFileSync(target.config, JSON.stringify(config)); writeFileSync(target.state, JSON.stringify(state));
    assert.equal(checkHub(target).needsUpdate, true);
    installHub(target);
    assert.equal(checkHub(target).needsUpdate, false);
    rollbackHub(target);
    assert.deepEqual(JSON.parse(readFileSync(target.config, 'utf8')), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
