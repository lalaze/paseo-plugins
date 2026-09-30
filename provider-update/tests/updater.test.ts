import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderUpdates, type Runner } from '../server/updater';

const home = '/Users/me';
const diagnostics: Record<string, string> = {
  claude: 'Claude Code\n  Resolved path: /Users/me/.local/bin/claude\n  Version: 2.1.284 (Claude Code)',
  codex: 'Codex\n  Resolved path: /Users/me/.local/bin/codex\n  Version: codex-cli 0.159.2',
  kimi: 'Kimi Code CLI\n  Error: spawn failed',
  pi: 'Pi\n  Resolved path: /opt/node/bin/pi',
};
const links: Record<string, string> = {
  '/Users/me/.local/bin/claude': '/Users/me/.local/share/claude/versions/2.1.284',
  '/Users/me/.local/bin/codex': '/Users/me/.codex/packages/standalone/releases/0.159.2/bin/codex',
  '/opt/node/bin/pi': '/opt/node/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
};

function fakeProviders(enabled = ['claude', 'codex', 'kimi', 'pi']) {
  const refreshed: string[][] = [];
  const providers = {
    snapshot: async () => ({ entries: [...enabled.map(provider => ({ provider, enabled: true })), { provider: 'opencode', enabled: false }] }),
    diagnostic: async (provider: string) => ({ provider, diagnostic: diagnostics[provider] ?? '', requestId: 'r' }),
    refresh: async (options?: { providers?: string[] }) => { refreshed.push(options?.providers ?? []); return {}; },
  } as unknown as Parameters<ProviderUpdates['list']>[0];
  return { providers, refreshed };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

describe('ProviderUpdates', () => {
  it('lists enabled providers with their installer and newest release', async () => {
    const { providers } = fakeProviders();
    const lookups: string[] = [];
    const probes: string[][] = [];
    const updates = new ProviderUpdates({
      home, resolve: async path => links[path] ?? path,
      run: async argv => { probes.push(argv); return { code: 0, output: '0.73.1\n' }; },
      latest: async name => { lookups.push(name); return { '@anthropic-ai/claude-code': '2.1.285', '@openai/codex': '0.159.2' }[name] ?? '0.74.0'; },
    });
    const { providers: rows } = await updates.list(providers, false);
    assert.deepEqual(rows.map(row => [row.provider, row.label, row.install, row.current, row.latest, row.updateAvailable, row.canUpdate]), [
      ['claude', 'Claude Code', 'claude-native', '2.1.284', '2.1.285', true, true],
      ['codex', 'Codex', 'codex-standalone', '0.159.2', '0.159.2', false, true],
      ['kimi', 'Kimi Code CLI', 'unknown', null, null, false, false],
      ['pi', 'Pi', 'npm', '0.73.1', '0.74.0', true, true],
    ]);
    // Pi's diagnostic has no version row, so the executable is asked directly.
    assert.deepEqual(probes, [['/opt/node/bin/pi', '--version']]);
    assert.match(rows[2].message ?? '', /did not report an executable/);
    // A second read within the cache window does not probe again.
    await updates.list(providers, false);
    assert.equal(lookups.length, 3);
    await updates.list(providers, true);
    assert.equal(lookups.length, 6);
  });

  it('runs the fixed updater once, reports progress, then refreshes the provider', async () => {
    const { providers, refreshed } = fakeProviders();
    const calls: string[][] = [];
    const finish = gate();
    const run: Runner = async argv => { calls.push(argv); await finish.opened; return { code: 0, output: '\x1b[32mUpdated to 2.1.285\x1b[0m\n' }; };
    const updates = new ProviderUpdates({ home, run, resolve: async path => links[path] ?? path, latest: async () => '2.1.285' });

    const started = await updates.update(providers, 'claude');
    assert.equal(started.state, 'updating');
    assert.deepEqual(calls, [['/Users/me/.local/share/claude/versions/2.1.284', 'update']]);
    await assert.rejects(updates.update(providers, 'codex'), /already updating/);

    diagnostics.claude = diagnostics.claude.replace('2.1.284', '2.1.285');
    finish.open();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const claude = (await updates.list(providers, false)).providers.find(row => row.provider === 'claude')!;
    assert.equal(claude.state, 'updated');
    assert.equal(claude.current, '2.1.285');
    assert.equal(claude.updateAvailable, false);
    assert.equal(claude.message, 'Updated to 2.1.285');
    assert.deepEqual(refreshed, [['claude']]);
    diagnostics.claude = diagnostics.claude.replace('2.1.285', '2.1.284');
  });

  it('keeps the tail of a failed update', async () => {
    const { providers } = fakeProviders();
    const run: Runner = async () => ({ code: 1, output: 'npm error EACCES: permission denied' });
    const updates = new ProviderUpdates({ home, run, resolve: async path => links[path] ?? path, latest: async () => null });
    await updates.update(providers, 'codex');
    await new Promise(resolve => setImmediate(resolve));
    const codex = (await updates.list(providers, false)).providers.find(row => row.provider === 'codex')!;
    assert.equal(codex.state, 'failed');
    assert.equal(codex.message, 'npm error EACCES: permission denied');
  });

  it('refuses disabled providers and unrecognised installs', async () => {
    const { providers } = fakeProviders();
    const run: Runner = async () => assert.fail('nothing should run');
    const updates = new ProviderUpdates({ home, run, resolve: async path => path, latest: async () => null });
    await assert.rejects(updates.update(providers, 'opencode'), /not enabled/);
    await assert.rejects(updates.update(providers, 'kimi'), /did not report an executable/);
  });
});
