import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { canonicalWorkspace } from '../server/local-files';
import { readWorkspaceChanges } from '../server/workspace-changes';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'dot-git-review-'));
  const root = canonicalWorkspace(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const commit = () => { git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline'); };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, git, commit };
}

test('non-Git, unborn and clean workspaces have explicit distinct baselines', async t => {
  const h = await fixture(t); await writeFile(join(h.root, 'draft.ts'), 'draft\n');
  const absent = await readWorkspaceChanges(h.root);
  assert.equal(absent.isGitRepository, false); assert.match(absent.note, /does not mean/);
  h.git('init', '-q'); h.git('add', 'draft.ts');
  const unborn = await readWorkspaceChanges(h.root);
  assert.equal(unborn.isGitRepository, true); assert.equal(unborn.headSha, null);
  assert.match(unborn.files[0]!.stagedDiff, /\+draft/);
  h.commit();
  const clean = await readWorkspaceChanges(h.root);
  assert.equal(clean.totalFiles, 0); assert.match(clean.headSha!, /^[a-f0-9]{40,64}$/);
});

test('Git deletion and rename diffs retain paths with spaces, Unicode and literal glob characters', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await writeFile(join(h.root, 'old name.ts'), 'old source\n');
  await writeFile(join(h.root, 'delete.ts'), 'delete source\n');
  await writeFile(join(h.root, '[a].ts'), 'literal before\n');
  await writeFile(join(h.root, 'a.ts'), 'other before\n'); h.commit();
  h.git('mv', 'old name.ts', '新 name.ts'); h.git('rm', '-q', 'delete.ts');
  await writeFile(join(h.root, '[a].ts'), 'literal after\n');
  await writeFile(join(h.root, 'a.ts'), 'other after\n');
  const result = await readWorkspaceChanges(h.root);
  const rename = result.files.find(file => file.path === '新 name.ts')!;
  assert.equal(rename.previousPath, 'old name.ts'); assert.match(rename.stagedDiff, /old source/);
  assert.match(result.files.find(file => file.path === 'delete.ts')!.stagedDiff, /-delete source/);
  const literal = result.files.find(file => file.path === '[a].ts')!;
  assert.match(literal.unstagedDiff, /literal after/); assert.doesNotMatch(literal.unstagedDiff, /other after/);
});

test('pagination is deterministic, and a subdirectory workspace never exposes sibling diffs or protected paths', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await mkdir(join(h.root, 'sub')); await writeFile(join(h.root, 'outside.ts'), 'outside baseline\n');
  await writeFile(join(h.root, 'sub/main.ts'), 'inside baseline\n'); h.commit();
  await writeFile(join(h.root, 'outside.ts'), 'PRIVATE OUTSIDE CONTENT\n');
  await writeFile(join(h.root, 'sub/main.ts'), 'inside edit\n');
  await writeFile(join(h.root, 'sub/.env'), 'PRIVATE SECRET CONTENT\n');
  for (let index = 0; index < 22; index++) await writeFile(join(h.root, `sub/new ${String(index).padStart(2, '0')}.ts`), `new ${index}\n`);
  const root = canonicalWorkspace(join(h.root, 'sub'));
  const first = await readWorkspaceChanges(root), second = await readWorkspaceChanges(root, first.nextOffset!);
  assert.equal(first.totalFiles, 23); assert.equal(first.files.length, 20); assert.equal(first.nextOffset, 20);
  assert.equal(second.files.length, 3); assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.files, ...second.files].map(file => file.path)).size, 23);
  assert.equal(first.excludedFileCount, 1);
  assert.doesNotMatch(JSON.stringify([first, second]), /PRIVATE|outside.ts|\.env/);
  assert.match(first.files.find(file => file.path === 'main.ts')!.unstagedDiff, /inside edit/);
});

test('protected rename origins are excluded and unreadable changed files retain explicit omissions', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await writeFile(join(h.root, '.env'), 'SECRET BASELINE\n'); h.commit();
  h.git('mv', '.env', 'innocent.ts');
  await writeFile(join(h.root, 'binary.ts'), Buffer.from([0xff, 0x00]));
  await writeFile(join(h.root, 'large.ts'), 'OVERSIZED PRIVATE '.repeat(20000));
  await symlink(join(h.root, 'innocent.ts'), join(h.root, 'symbolic.ts'));
  await writeFile(join(h.root, 'hard-original.ts'), 'HARDLINK CONTENT\n');
  await link(join(h.root, 'hard-original.ts'), join(h.root, 'hard.ts'));
  const result = await readWorkspaceChanges(h.root);
  assert.equal(result.excludedFileCount, 1);
  for (const path of ['binary.ts', 'large.ts', 'symbolic.ts', 'hard.ts', 'hard-original.ts']) {
    const file = result.files.find(file => file.path === path)!;
    assert.ok(file.omittedReason, path); assert.equal(file.untrackedDiff, '');
  }
  assert.doesNotMatch(JSON.stringify(result), /SECRET BASELINE|OVERSIZED PRIVATE|HARDLINK CONTENT/);
});

test('diff output limits are explicit without hiding changed files', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await writeFile(join(h.root, 'tracked.ts'), 'before\n'); h.commit();
  await writeFile(join(h.root, 'tracked.ts'), '中'.repeat(30000) + '\n');
  for (let i = 0; i < 12; i++) await writeFile(join(h.root, `new${i}.ts`), 'a'.repeat(25000) + '\n');
  const result = await readWorkspaceChanges(h.root);
  assert.equal(result.totalFiles, 13); assert.equal(result.files.length, 13);
  assert.ok(result.files.some(file => file.diffTruncated));
  const text = result.files.map(file => file.stagedDiff + file.unstagedDiff + file.untrackedDiff).join('');
  assert.ok(Buffer.byteLength(text) <= 128 * 1024); assert.ok(!text.includes('\ufffd'));
  assert.equal(result.nextOffset, null);
});

test('Git reads disable configured external diff, textconv and filesystem-monitor executables', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await writeFile(join(h.root, 'main.ts'), 'before\n');
  await writeFile(join(h.root, '.gitattributes'), '*.ts diff=custom\n'); h.commit();
  await writeFile(join(h.root, 'main.ts'), 'after\n');
  const marker = join(h.root, 'helper-ran');
  const helper = join(h.root, 'helper.sh'); await writeFile(helper, `#!/bin/sh\necho executed > '${marker}'\n`, { mode: 0o755 });
  h.git('config', 'diff.external', helper); h.git('config', 'diff.custom.textconv', helper); h.git('config', 'core.fsmonitor', helper);
  const result = await readWorkspaceChanges(h.root);
  assert.match(result.files.find(file => file.path === 'main.ts')!.unstagedDiff, /-before[\s\S]*\+after/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('aborted Git reads and invalid offsets do not become clean-workspace results', async t => {
  const h = await fixture(t); h.git('init', '-q');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readWorkspaceChanges(h.root, 0, controller.signal), /failed|limit/);
  await assert.rejects(readWorkspaceChanges(h.root, -1), /offset/);
});

test('dirty Git submodules remain visible as changed directories with explicit diff omissions', async t => {
  const h = await fixture(t); h.git('init', '-q');
  const module = join(h.root, 'module'); await mkdir(module);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: module, encoding: 'utf8' });
  git('init', '-q'); await writeFile(join(module, 'main.ts'), 'module before\n');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'module baseline');
  h.commit(); await writeFile(join(module, 'main.ts'), 'module edit\n');
  const changes = await readWorkspaceChanges(h.root);
  assert.equal(changes.totalFiles, 1); assert.equal(changes.files[0]!.path, 'module');
  assert.equal(changes.files[0]!.worktreeStatus, 'M'); assert.ok(changes.files[0]!.omittedReason);
});
