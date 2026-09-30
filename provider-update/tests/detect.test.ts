import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyInstall, compareVersions, installRoots, parseVersion, readDiagnostic, scriptOf } from '../server/detect';

const homeRoots = {
  claude: ['/Users/me/.local/share/claude/versions'],
  codex: ['/Users/me/.codex/packages/standalone'],
  grok: ['/Users/me/.grok/downloads'],
  kimi: ['/Users/me/.kimi-code/bin'],
  kimiCdn: 'https://code.kimi.com/kimi-code',
};

describe('readDiagnostic', () => {
  it('takes the title, resolved path and version rows Paseo prints', () => {
    const text = 'Codex\n  Command source: default\n  PATH matches: /Users/me/.local/bin/codex\n    /opt/node/bin/codex\n  Resolved path: /Users/me/.local/bin/codex\n  Version: codex-cli 0.159.2\n  Models: 8';
    assert.deepEqual(readDiagnostic(text), { title: 'Codex', resolvedPath: '/Users/me/.local/bin/codex', version: 'codex-cli 0.159.2', command: null });
  });

  it('reads the configured command', () => {
    const text = 'Hub (ACP)\n  Configured command: /opt/node/bin/node /src/hub/hub.mjs run\n  Resolved path: /opt/node/bin/node\n  Version: v22.23.2';
    assert.equal(readDiagnostic(text).command, '/opt/node/bin/node /src/hub/hub.mjs run');
  });

  it('reads a version pushed onto later lines by CLI warnings', () => {
    const text = 'Pi\n  Resolved path: /opt/node/bin/pi\n  Version: (node:1) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental\n(Use `node --trace-warnings ...` to show where the warning was created)\n0.73.1\n  Auth config (~/.pi/agent/auth.json): found';
    assert.equal(parseVersion(readDiagnostic(text).version), '0.73.1');
  });

  it('ignores a resolved path that is not absolute', () => {
    assert.equal(readDiagnostic('Pi\n  Resolved path: Not found\n').resolvedPath, null);
    assert.equal(readDiagnostic('Pi\n  Error: boom').resolvedPath, null);
  });
});

describe('versions', () => {
  it('extracts the first semver from CLI output', () => {
    assert.equal(parseVersion('2.1.284 (Claude Code)'), '2.1.284');
    assert.equal(parseVersion('codex-cli 0.159.2'), '0.159.2');
    assert.equal(parseVersion('pi 1.0.0-beta.2'), '1.0.0-beta.2');
    assert.equal(parseVersion('unknown'), null);
  });

  it('orders numerically, with releases after their prereleases', () => {
    assert.ok(compareVersions('2.1.285', '2.1.284') > 0);
    assert.ok(compareVersions('0.160.0', '0.159.12') > 0);
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareVersions('1.0.0', '1.0.0-beta.2') > 0);
    assert.ok(compareVersions('1.0.0-beta.10', '1.0.0-beta.2') > 0);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });
});

describe('classifyInstall', () => {
  it('uses the Claude native updater for native builds', () => {
    const installer = classifyInstall('/Users/me/.local/share/claude/versions/2.1.284', homeRoots);
    assert.equal(installer.kind, 'claude-native');
    assert.deepEqual(installer.command, ['/Users/me/.local/share/claude/versions/2.1.284', 'update']);
    assert.deepEqual(installer.feed, { kind: 'npm', name: '@anthropic-ai/claude-code' });
  });

  it('uses the Codex updater for standalone releases', () => {
    const binary = '/Users/me/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin/bin/codex';
    const installer = classifyInstall(binary, homeRoots);
    assert.equal(installer.kind, 'codex-standalone');
    assert.deepEqual(installer.command, [binary, 'update']);
    assert.deepEqual(installer.feed, { kind: 'npm', name: '@openai/codex' });
  });

  it('uses Grok\'s own updater, pinned to the standalone installer', () => {
    const binary = '/Users/me/.grok/downloads/grok-1.0.41-macos-aarch64';
    const installer = classifyInstall(binary, homeRoots);
    assert.equal(installer.kind, 'grok-standalone');
    assert.deepEqual(installer.command, [binary, 'update']);
    assert.deepEqual(installer.env, { GROK_INSTALLER: 'internal' });
    assert.deepEqual(installer.feed, { kind: 'command', argv: [binary, 'update', '--check', '--json'], env: { GROK_INSTALLER: 'internal' }, field: 'latestVersion' });
  });

  it('uses Kimi\'s own upgrader and its regional release feed', () => {
    const installer = classifyInstall('/Users/me/.kimi-code/bin/kimi', homeRoots);
    assert.equal(installer.kind, 'kimi-standalone');
    assert.deepEqual(installer.command, ['/Users/me/.kimi-code/bin/kimi', 'upgrade', '--yes']);
    assert.deepEqual(installer.feed, { kind: 'url', url: 'https://code.kimi.com/kimi-code/latest' });
  });

  it('reinstalls global npm packages with the npm of the same prefix', () => {
    const installer = classifyInstall('/Users/me/.nvm/versions/node/v22.23.2/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js', homeRoots);
    assert.equal(installer.kind, 'npm');
    assert.deepEqual(installer.command, ['/Users/me/.nvm/versions/node/v22.23.2/bin/npm', 'install', '--global', '--no-fund', '--no-audit', '@mariozechner/pi-coding-agent@latest']);
    assert.equal(installer.pathPrefix, '/Users/me/.nvm/versions/node/v22.23.2/bin');
    assert.deepEqual(classifyInstall('/opt/homebrew/lib/node_modules/opencode-ai/bin/opencode', homeRoots).feed, { kind: 'npm', name: 'opencode-ai' });
  });

  it('upgrades Homebrew formulae and casks by name', () => {
    assert.deepEqual(classifyInstall('/opt/homebrew/Cellar/gemini-cli/0.9.0/bin/gemini', homeRoots).command, ['/opt/homebrew/bin/brew', 'upgrade', 'gemini-cli']);
    const cask = classifyInstall('/opt/homebrew/Caskroom/codex/0.159.2/codex', homeRoots);
    assert.equal(cask.kind, 'homebrew-cask');
    assert.deepEqual(cask.command, ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'codex']);
  });

  it('recognises installs under a symlinked home directory', async () => {
    const roots = await installRoots('/Users/me', async path => path.replace('/Users/me/.local/share', '/Volumes/data/offload/.local/share'), async () => { throw new Error('ENOENT'); });
    assert.deepEqual(roots.claude, ['/Users/me/.local/share/claude/versions', '/Volumes/data/offload/.local/share/claude/versions']);
    assert.equal(classifyInstall('/Volumes/data/offload/.local/share/claude/versions/2.1.284', roots).kind, 'claude-native');
  });

  it('reads Kimi\'s release feed from the region it logged in to', async () => {
    const read = (region: string) => async (path: string) => { assert.equal(path, '/Users/me/.kimi-code/region'); return `${region}\n`; };
    assert.equal((await installRoots('/Users/me', async path => path, read('global'))).kimiCdn, 'https://code.kimi.ai/kimi-code');
    assert.equal((await installRoots('/Users/me', async path => path, read('mainland-cn'))).kimiCdn, 'https://code.kimi.com/kimi-code');
    assert.equal((await installRoots('/Users/me', async path => path, async () => { throw new Error('ENOENT'); })).kimiCdn, 'https://code.kimi.com/kimi-code');
  });

  it('refuses paths it does not recognise', () => {
    assert.deepEqual(classifyInstall('/usr/local/bin/kimi', homeRoots), { kind: 'unknown', command: null, pathPrefix: null, env: null, feed: null });
    // Another user's native build is not ours to run.
    assert.equal(classifyInstall('/Users/other/.local/share/claude/versions/2.1.284', homeRoots).kind, 'unknown');
  });
});

describe('scriptOf', () => {
  it('finds the script an interpreter runs', () => {
    assert.equal(scriptOf('/opt/node/bin/node', '/opt/node/bin/node /src/hub/hub.mjs run'), '/src/hub/hub.mjs');
    assert.equal(scriptOf('/usr/bin/python3.12', 'python3.12 -u /src/agent.py'), '/src/agent.py');
  });

  it('leaves providers that are their own executable alone', () => {
    assert.equal(scriptOf('/Users/me/.kimi-code/bin/kimi', 'kimi acp'), null);
    assert.equal(scriptOf('/opt/node/bin/node', null), null);
    // A relative script cannot be located from here.
    assert.equal(scriptOf('/opt/node/bin/node', 'node hub.mjs'), null);
  });
});
