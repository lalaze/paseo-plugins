import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyInstall, compareVersions, installRoots, parseVersion, readDiagnostic } from '../server/detect';

const homeRoots = { claude: ['/Users/me/.local/share/claude/versions'], codex: ['/Users/me/.codex/packages/standalone'] };

describe('readDiagnostic', () => {
  it('takes the title, resolved path and version rows Paseo prints', () => {
    const text = 'Codex\n  Command source: default\n  PATH matches: /Users/me/.local/bin/codex\n    /opt/node/bin/codex\n  Resolved path: /Users/me/.local/bin/codex\n  Version: codex-cli 0.159.2\n  Models: 8';
    assert.deepEqual(readDiagnostic(text), { title: 'Codex', resolvedPath: '/Users/me/.local/bin/codex', version: 'codex-cli 0.159.2' });
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
    assert.equal(installer.registryPackage, '@anthropic-ai/claude-code');
  });

  it('uses the Codex updater for standalone releases', () => {
    const binary = '/Users/me/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin/bin/codex';
    const installer = classifyInstall(binary, homeRoots);
    assert.equal(installer.kind, 'codex-standalone');
    assert.deepEqual(installer.command, [binary, 'update']);
    assert.equal(installer.registryPackage, '@openai/codex');
  });

  it('reinstalls global npm packages with the npm of the same prefix', () => {
    const installer = classifyInstall('/Users/me/.nvm/versions/node/v22.23.2/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js', homeRoots);
    assert.equal(installer.kind, 'npm');
    assert.deepEqual(installer.command, ['/Users/me/.nvm/versions/node/v22.23.2/bin/npm', 'install', '--global', '--no-fund', '--no-audit', '@mariozechner/pi-coding-agent@latest']);
    assert.equal(installer.pathPrefix, '/Users/me/.nvm/versions/node/v22.23.2/bin');
    assert.equal(classifyInstall('/opt/homebrew/lib/node_modules/opencode-ai/bin/opencode', homeRoots).registryPackage, 'opencode-ai');
  });

  it('upgrades Homebrew formulae and casks by name', () => {
    assert.deepEqual(classifyInstall('/opt/homebrew/Cellar/gemini-cli/0.9.0/bin/gemini', homeRoots).command, ['/opt/homebrew/bin/brew', 'upgrade', 'gemini-cli']);
    const cask = classifyInstall('/opt/homebrew/Caskroom/codex/0.159.2/codex', homeRoots);
    assert.equal(cask.kind, 'homebrew-cask');
    assert.deepEqual(cask.command, ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'codex']);
  });

  it('recognises installs under a symlinked home directory', async () => {
    const roots = await installRoots('/Users/me', async path => path.replace('/Users/me/.local/share', '/Volumes/data/offload/.local/share'));
    assert.deepEqual(roots.claude, ['/Users/me/.local/share/claude/versions', '/Volumes/data/offload/.local/share/claude/versions']);
    assert.equal(classifyInstall('/Volumes/data/offload/.local/share/claude/versions/2.1.284', roots).kind, 'claude-native');
  });

  it('refuses paths it does not recognise', () => {
    assert.deepEqual(classifyInstall('/usr/local/bin/kimi', homeRoots), { kind: 'unknown', command: null, pathPrefix: null, registryPackage: null });
    // Another user's native build is not ours to run.
    assert.equal(classifyInstall('/Users/other/.local/share/claude/versions/2.1.284', homeRoots).kind, 'unknown');
  });
});
