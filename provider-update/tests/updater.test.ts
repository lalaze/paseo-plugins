import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { feedLatest, ProviderUpdates, type Runner } from '../server/updater';

const home = '/Users/me';
const diagnostics: Record<string, string> = {
  claude: 'Claude Code\n  Resolved path: /Users/me/.local/bin/claude\n  Version: 2.1.284 (Claude Code)',
  codex: 'Codex\n  Resolved path: /Users/me/.local/bin/codex\n  Version: codex-cli 0.159.2',
  kimi: 'Kimi Code CLI\n  Error: spawn failed',
  pi: 'Pi\n  Resolved path: /opt/node/bin/pi',
  hub: 'Hub (ACP)\n  Configured command: /opt/node/bin/node /src/hub/hub.mjs run\n  Resolved path: /opt/node/bin/node\n  Version: v22.23.2',
  grok: 'Grok\n  Resolved path: /Users/me/.local/bin/grok\n  Version: 1.0.41',
};
const links: Record<string, string> = {
  '/Users/me/.local/bin/claude': '/Users/me/.local/share/claude/versions/2.1.284',
  '/Users/me/.local/bin/codex': '/Users/me/.codex/packages/standalone/releases/0.159.2/bin/codex',
  '/opt/node/bin/pi': '/opt/node/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
  '/Users/me/.local/bin/grok': '/Users/me/.grok/downloads/grok-1.0.41-macos-aarch64',
};
const files: Record<string, string> = { '/src/hub/package.json': '{"name":"hub","version":"0.3.0"}' };
const read = async (path: string) => files[path] ?? Promise.reject(new Error(`ENOENT: ${path}`));

function fakeProviders(enabled = ['claude', 'codex', 'kimi', 'pi', 'hub']) {
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
      home, read, resolve: async path => links[path] ?? path,
      run: async argv => { probes.push(argv); return { code: 0, output: '0.73.1\n' }; },
      latest: async feed => {
        const name = feed.kind === 'npm' ? feed.name : '';
        lookups.push(name);
        return { '@anthropic-ai/claude-code': '2.1.285', '@openai/codex': '0.159.2' }[name] ?? '0.74.0';
      },
    });
    const { providers: rows } = await updates.list(providers, false);
    assert.deepEqual(rows.map(row => [row.provider, row.label, row.install, row.current, row.latest, row.updateAvailable, row.canUpdate]), [
      ['claude', 'Claude Code', 'claude-native', '2.1.284', '2.1.285', true, true],
      ['codex', 'Codex', 'codex-standalone', '0.159.2', '0.159.2', false, true],
      ['kimi', 'Kimi Code CLI', 'unknown', null, null, false, false],
      ['pi', 'Pi', 'npm', '0.73.1', '0.74.0', true, true],
      // The version is the script's package, not the node that runs it.
      ['hub', 'Hub (ACP)', 'script', '0.3.0', null, false, false],
    ]);
    assert.equal(rows[4].binary, '/src/hub/hub.mjs');
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
    const updates = new ProviderUpdates({ home, read, run, resolve: async path => links[path] ?? path, latest: async () => '2.1.285' });

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
    const updates = new ProviderUpdates({ home, read, run, resolve: async path => links[path] ?? path, latest: async () => null });
    await updates.update(providers, 'codex');
    await new Promise(resolve => setImmediate(resolve));
    const codex = (await updates.list(providers, false)).providers.find(row => row.provider === 'codex')!;
    assert.equal(codex.state, 'failed');
    assert.equal(codex.message, 'npm error EACCES: permission denied');
  });

  it('refuses disabled providers and unrecognised installs', async () => {
    const { providers } = fakeProviders();
    const run: Runner = async () => assert.fail('nothing should run');
    const updates = new ProviderUpdates({ home, read, run, resolve: async path => path, latest: async () => null });
    await assert.rejects(updates.update(providers, 'opencode'), /not enabled/);
    await assert.rejects(updates.update(providers, 'kimi'), /did not report an executable/);
    await assert.rejects(updates.update(providers, 'hub'), /No known way/);
  });

  it('runs Grok\'s updater with its installer pinned', async () => {
    const { providers } = fakeProviders(['grok']);
    const calls: { argv: string[]; env: Record<string, string> | null | undefined }[] = [];
    const run: Runner = async (argv, { env }) => { calls.push({ argv, env }); return { code: 0, output: '' }; };
    const updates = new ProviderUpdates({ home, read, run, resolve: async path => links[path] ?? path, latest: async () => '1.0.44' });
    const started = await updates.update(providers, 'grok');
    assert.equal(started.install, 'grok-standalone');
    assert.equal(started.latest, '1.0.44');
    assert.deepEqual(calls, [{ argv: ['/Users/me/.grok/downloads/grok-1.0.41-macos-aarch64', 'update'], env: { GROK_INSTALLER: 'internal' } }]);
  });
});

describe('feedLatest', () => {
  it('reads npm, a plain-text URL and a JSON-printing command', async () => {
    const seen: { argv: string[]; env: Record<string, string> | null | undefined }[] = [];
    const run: Runner = async (argv, { env }) => {
      seen.push({ argv, env });
      return argv[0] === 'npm'
        ? { code: 0, output: '(node:1) Warning: experimental\n0.74.0\n' }
        : { code: 0, output: 'warning: slow network\n{"currentVersion":"1.0.41","latestVersion":"1.0.44"}\n' };
    };
    const latest = feedLatest(run, async url => { assert.equal(url, 'https://cdn.example/latest'); return '2.1.1\n'; });
    assert.equal(await latest({ kind: 'npm', name: 'pi' }), '0.74.0');
    assert.equal(await latest({ kind: 'url', url: 'https://cdn.example/latest' }), '2.1.1');
    assert.equal(await latest({ kind: 'command', argv: ['grok', 'update', '--check', '--json'], env: { GROK_INSTALLER: 'internal' }, field: 'latestVersion' }), '1.0.44');
    assert.deepEqual(seen[1], { argv: ['grok', 'update', '--check', '--json'], env: { GROK_INSTALLER: 'internal' } });
  });
});
