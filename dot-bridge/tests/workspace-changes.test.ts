import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, readFile, chmod, stat } from 'node:fs/promises';
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
  await writeFile(join(h.root, 'sub/main.ts'), 'inside staged\n'); h.git('add', 'sub/main.ts');
  await writeFile(join(h.root, 'sub/main.ts'), 'inside edit\n');
  await writeFile(join(h.root, 'sub/.env'), 'PRIVATE SECRET CONTENT\n');
  for (let index = 0; index < 22; index++) await writeFile(join(h.root, `sub/new ${String(index).padStart(2, '0')}.ts`), `new ${index}\n`);
  const root = canonicalWorkspace(join(h.root, 'sub'));
  const first = await readWorkspaceChanges(root), second = await readWorkspaceChanges(root, first.nextOffset!, undefined, { snapshotId: first.snapshotId });
  assert.equal(first.totalFiles, 23); assert.equal(first.files.length, 20); assert.equal(first.nextOffset, 20);
  assert.equal(second.files.length, 3); assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.files, ...second.files].map(file => file.path)).size, 23);
  assert.equal(first.excludedFileCount, 1);
  assert.doesNotMatch(JSON.stringify([first, second]), /PRIVATE|outside.ts|\.env/);
  assert.match(first.files.find(file => file.path === 'main.ts')!.stagedDiff, /-inside baseline[\s\S]*\+inside staged/);
  assert.match(first.files.find(file => file.path === 'main.ts')!.unstagedDiff, /-inside staged[\s\S]*\+inside edit/);
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

test('pagination binds file membership and bytes to the first snapshot', async t => {
  const h = await fixture(t); h.git('init', '-q');
  for (let i = 0; i < 23; i++) await writeFile(join(h.root, `file${String(i).padStart(2, '0')}.ts`), `${i}\n`);
  const first = await readWorkspaceChanges(h.root);
  assert.match(first.snapshotId!, /^[a-f0-9]{64}$/);
  await assert.rejects(readWorkspaceChanges(h.root, first.nextOffset!), /snapshot/i);
  await writeFile(join(h.root, '00-new.ts'), 'new\n');
  await assert.rejects(readWorkspaceChanges(h.root, first.nextOffset!, undefined, { snapshotId: first.snapshotId }), /snapshot|changed/i);
  const fresh = await readWorkspaceChanges(h.root);
  await writeFile(join(h.root, 'file22.ts'), 'edited while still untracked\n');
  await assert.rejects(readWorkspaceChanges(h.root, fresh.nextOffset!, undefined, { snapshotId: fresh.snapshotId }), /snapshot|changed/i);
});

test('assume-unchanged and present skip-worktree files are explicitly compared without modifying the index', async t => {
  const h = await fixture(t); h.git('init', '-q');
  for (const path of ['assume.ts', 'skip.ts']) await writeFile(join(h.root, path), 'before\n');
  h.commit(); h.git('update-index', '--assume-unchanged', 'assume.ts'); h.git('update-index', '--skip-worktree', 'skip.ts');
  const index = h.git('ls-files', '--stage', '-v');
  for (const path of ['assume.ts', 'skip.ts']) await writeFile(join(h.root, path), 'after\n');
  const changes = await readWorkspaceChanges(h.root);
  assert.equal(changes.totalFiles, 2);
  for (const file of changes.files) assert.match(file.unstagedDiff, /-before[\s\S]*\+after/);
  assert.equal(h.git('ls-files', '--stage', '-v'), index);
});

for (const mutation of ['index', 'disk'] as const) test('same MM status cannot hide a concurrent ' + mutation + ' change', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await writeFile(join(h.root, 'main.ts'), 'value 1\n'); h.commit();
  await writeFile(join(h.root, 'main.ts'), 'value 2\n'); h.git('add', 'main.ts');
  await writeFile(join(h.root, 'main.ts'), 'value 3\n');
  const indexOid = h.git('rev-parse', ':main.ts').trim();
  const initial = h.git('status', '--porcelain=v1');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(h.root, 'bin'); await mkdir(bin);
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  await writeFile(join(bin, 'git'), `#!/bin/sh\n${quote(realGit)} "$@"\ncode=$?\ncase " $* " in\n*' cat-file blob ${indexOid} '*) printf 'value 4\\n' > ${quote(join(h.root, 'main.ts'))}; ${mutation === 'index' ? `${quote(realGit)} -C ${quote(h.root)} add -- main.ts;` : ''} printf 'value 5\\n' > ${quote(join(h.root, 'main.ts'))};;\nesac\nexit "$code"\n`, { mode: 0o755 });
  const before = h.git('status', '--porcelain=v1');
  const previousPath = process.env.PATH; process.env.PATH = bin + ':' + previousPath;
  try { await assert.rejects(readWorkspaceChanges(h.root), /snapshot changed/i); }
  finally { process.env.PATH = previousPath; }
  assert.equal(h.git('status', '--porcelain=v1'), before); assert.match(initial, /MM main.ts/);
});

test('large staged, unstaged and new-file patches resume by exact UTF-8 byte offsets in one snapshot', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await writeFile(join(h.root, 'main.ts'), 'before\n'); h.commit();
  await writeFile(join(h.root, 'main.ts'), '中'.repeat(15000) + '\n'); h.git('add', 'main.ts');
  await writeFile(join(h.root, 'main.ts'), '🙂'.repeat(15000) + '\n');
  await writeFile(join(h.root, 'new.ts'), '中'.repeat(30000));
  const first = await readWorkspaceChanges(h.root);
  for (const [path, kind, field] of [['main.ts', 'staged', 'stagedDiff'], ['main.ts', 'unstaged', 'unstagedDiff'], ['new.ts', 'untracked', 'untrackedDiff']] as const) {
    const file = first.files.find(file => file.path === path)!;
    let patch = file[field], next = file.nextDiffs.find(next => next.kind === kind);
    while (next) {
      const part = await readWorkspaceChanges(h.root, 0, undefined, { snapshotId: first.snapshotId, path, diffKind: kind, diffOffset: next.offset, diffSha256: next.sha256 });
      patch += part.files[0]![field]; const following = part.files[0]!.nextDiffs.find(next => next.kind === kind);
      if (following) assert.ok(following.offset > next.offset); next = following;
    }
    assert.ok(!patch.includes('\ufffd'));
    const applyRoot = await mkdtemp(join(tmpdir(), `dot-apply-${kind}-`)); t.after(() => rm(applyRoot, { recursive: true, force: true }));
    if (kind !== 'untracked') await writeFile(join(applyRoot, path), kind === 'staged' ? 'before\n' : '中'.repeat(15000) + '\n');
    execFileSync('git', ['apply', '--no-index', '-'], { cwd: applyRoot, input: patch });
    const expected = kind === 'staged' ? '中'.repeat(15000) + '\n' : kind === 'unstaged' ? '🙂'.repeat(15000) + '\n' : '中'.repeat(30000);
    assert.equal(await readFile(join(applyRoot, path), 'utf8'), expected);
  }
});

test('detached linked worktrees use their own working directory, index and HEAD', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await writeFile(join(h.root, 'main.ts'), 'before\n'); h.commit();
  const linked = join(h.root, 'linked'); h.git('worktree', 'add', '--detach', linked);
  await writeFile(join(h.root, 'main.ts'), 'original edit\n');
  await writeFile(join(linked, 'main.ts'), 'linked edit\n');
  const changes = await readWorkspaceChanges(canonicalWorkspace(linked));
  assert.equal(changes.totalFiles, 1); assert.equal(changes.headSha, h.git('rev-parse', 'HEAD').trim());
  assert.match(changes.files[0]!.unstagedDiff, /linked edit/); assert.doesNotMatch(changes.files[0]!.unstagedDiff, /original edit/);
});

test('renames across a subdirectory boundary show only its local side', async t => {
  const h = await fixture(t); h.git('init', '-q'); await mkdir(join(h.root, 'sub'));
  await writeFile(join(h.root, 'outside.ts'), 'incoming\n');
  await writeFile(join(h.root, 'sub/outgoing.ts'), 'outgoing\n'); h.commit();
  h.git('mv', 'outside.ts', 'sub/incoming.ts'); h.git('mv', 'sub/outgoing.ts', 'outside-new.ts');
  const changes = await readWorkspaceChanges(canonicalWorkspace(join(h.root, 'sub')));
  assert.equal(changes.totalFiles, 2);
  assert.deepEqual(changes.files.map(file => file.path).sort(), ['incoming.ts', 'outgoing.ts']);
  assert.ok(changes.files.every(file => file.previousPath === null));
  assert.doesNotMatch(JSON.stringify(changes), /outside\.ts|outside-new\.ts/);
});

test('unresolved merge conflicts are explicitly identified and preserve conflict text', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await writeFile(join(h.root, 'main.ts'), 'base\n'); h.commit();
  const branch = h.git('symbolic-ref', '--short', 'HEAD').trim();
  h.git('checkout', '-qb', 'other'); await writeFile(join(h.root, 'main.ts'), 'other\n'); h.commit();
  h.git('checkout', '-q', branch); await writeFile(join(h.root, 'main.ts'), 'current\n'); h.commit();
  assert.throws(() => h.git('merge', 'other'));
  const changes = await readWorkspaceChanges(h.root);
  assert.equal(changes.totalFiles, 1); assert.equal(changes.files[0]!.conflicted, true);
  assert.match(changes.files[0]!.unstagedDiff, /<<<<<<<|current|other/);
});

test('absent sparse-checkout files and nested repositories are not reported as clean or deleted files', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await writeFile(join(h.root, 'sparse.ts'), 'baseline\n'); h.commit();
  h.git('update-index', '--skip-worktree', 'sparse.ts'); await rm(join(h.root, 'sparse.ts'));
  const sparse = await readWorkspaceChanges(h.root);
  assert.equal(sparse.totalFiles, 0); assert.equal(sparse.hiddenUnverifiedCount, 1);
  const nested = join(h.root, 'nested'); await mkdir(nested); execFileSync('git', ['init', '-q'], { cwd: nested });
  await writeFile(join(nested, 'main.ts'), 'nested source\n');
  const changes = await readWorkspaceChanges(h.root);
  assert.equal(changes.totalFiles, 1); assert.equal(changes.files[0]!.path, 'nested'); assert.ok(changes.files[0]!.omittedReason);
});

test('staged edits do not hide an additional working-tree edit behind assume-unchanged', async t => {
  const h = await fixture(t); h.git('init', '-q');
  await writeFile(join(h.root, 'main.ts'), 'base\n'); h.commit();
  await writeFile(join(h.root, 'main.ts'), 'staged\n'); h.git('add', 'main.ts');
  h.git('update-index', '--assume-unchanged', 'main.ts'); await writeFile(join(h.root, 'main.ts'), 'disk\n');
  const changes = await readWorkspaceChanges(h.root);
  assert.equal(changes.totalFiles, 1); assert.equal(changes.files[0]!.indexStatus, 'M'); assert.equal(changes.files[0]!.worktreeStatus, 'M');
  assert.match(changes.files[0]!.stagedDiff, /-base[\s\S]*\+staged/);
  assert.match(changes.files[0]!.unstagedDiff, /-staged[\s\S]*\+disk/);
});


test('Git diff configuration cannot change a patch between continuation chunks', async t => {
  const h = await fixture(t); h.git('init', '-q');
  const before = Array.from({ length: 2400 }, (_, i) => `line ${i} original text repeated repeated\n`).join('');
  const after = before.split('\n').map((line, i) => i >= 500 && i < 1900 ? line.replace('original', 'changed') : line).join('\n');
  await writeFile(join(h.root, 'main.ts'), before); h.commit(); await writeFile(join(h.root, 'main.ts'), after);
  h.git('config', 'diff.context', '0');
  const first = await readWorkspaceChanges(h.root); let patch = first.files[0]!.unstagedDiff;
  let next = first.files[0]!.nextDiffs[0]; assert.ok(next);
  h.git('config', 'diff.context', '20');
  while (next) {
    const part = await readWorkspaceChanges(h.root, 0, undefined, { snapshotId: first.snapshotId, path: 'main.ts', diffKind: 'unstaged', diffOffset: next.offset, diffSha256: next.sha256 });
    patch += part.files[0]!.unstagedDiff; next = part.files[0]!.nextDiffs[0];
  }
  const applyRoot = await mkdtemp(join(tmpdir(), 'dot-apply-config-')); t.after(() => rm(applyRoot, { recursive: true, force: true })); await writeFile(join(applyRoot, 'main.ts'), before);
  execFileSync('git', ['apply', '--no-index', '-'], { cwd: applyRoot, input: patch });
  assert.equal(await readFile(join(applyRoot, 'main.ts'), 'utf8'), after);
});

test('a transient index/disk change cannot mix different baselines in returned diffs', async t => {
  const h = await fixture(t); h.git('init', '-q');
  const source = join(h.root, 'main.ts');
  await writeFile(source, 'value 1\n'); h.commit(); const headOid = h.git('rev-parse', 'HEAD:main.ts').trim();
  await writeFile(source, 'value 2\n'); h.git('add', 'main.ts'); const indexOid = h.git('rev-parse', ':main.ts').trim();
  await writeFile(source, 'value 3\n');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = await mkdtemp(join(tmpdir(), 'dot-git-wrapper-')); t.after(() => rm(bin, { recursive: true, force: true }));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(join(bin, 'git'), `#!/bin/sh\n${quote(realGit)} "$@"\ncode=$?\ncase " $* " in
*' diff --cached '*|*' cat-file blob ${headOid} '*) printf 'value 4\\n' > ${quote(source)}; ${quote(realGit)} -C ${quote(h.root)} add -- main.ts; printf 'value 5\\n' > ${quote(source)};;
*' diff --no-ext-diff '*|*' cat-file blob ${indexOid} '*) printf 'value 2\\n' > ${quote(source)}; ${quote(realGit)} -C ${quote(h.root)} add -- main.ts; printf 'value 3\\n' > ${quote(source)};;
esac\nexit "$code"\n`, { mode: 0o755 });
  const previousPath = process.env.PATH; process.env.PATH = bin + ':' + previousPath;
  try {
    const result = await readWorkspaceChanges(h.root); const file = result.files[0]!;
    assert.match(file.stagedDiff, /-value 1[\s\S]*\+value 2/);
    assert.match(file.unstagedDiff, /-value 2[\s\S]*\+value 3/);
    assert.doesNotMatch(file.stagedDiff + file.unstagedDiff, /value [45]/);
  } finally { process.env.PATH = previousPath; }
});


test('diff continuations reject missing or mismatched patch fingerprints', async t => {
  const h = await fixture(t); h.git('init', '-q'); await writeFile(join(h.root, 'main.ts'), 'x'.repeat(50000));
  const first = await readWorkspaceChanges(h.root), next = first.files[0]!.nextDiffs[0]!;
  const input = { snapshotId: first.snapshotId, path: 'main.ts', diffKind: 'untracked' as const, diffOffset: next.offset };
  await assert.rejects(readWorkspaceChanges(h.root, 0, undefined, input), /diffSha256/);
  await assert.rejects(readWorkspaceChanges(h.root, 0, undefined, { ...input, diffSha256: '0'.repeat(64) }), /snapshot changed/i);
  const part = await readWorkspaceChanges(h.root, 0, undefined, { ...input, diffSha256: next.sha256 });
  assert.ok(part.files[0]!.untrackedDiff.length);
});

test('captured patches apply quoted paths, CRLF, EOF, empty files, renames and executable modes', async t => {
  const h = await fixture(t); h.git('init', '-q');
  const initial = new Map([
    ['quote " 中.ts', '\ufeffbefore\r\nlast'], ['old.ts', 'rename\n'], ['mode.ts', 'same\n'], ['delete.ts', 'delete\n'], ['empty-deleted.ts', ''],
  ]);
  for (const [path, text] of initial) await writeFile(join(h.root, path), text);
  await chmod(join(h.root, 'delete.ts'), 0o755); h.commit();
  await writeFile(join(h.root, 'quote " 中.ts'), '\ufeffafter\r\nlast edited');
  h.git('mv', 'old.ts', 'new name.ts'); await chmod(join(h.root, 'mode.ts'), 0o755);
  await rm(join(h.root, 'delete.ts')); await rm(join(h.root, 'empty-deleted.ts'));
  await writeFile(join(h.root, 'empty-new.ts'), ''); await writeFile(join(h.root, 'run.ts'), 'execute\n', { mode: 0o755 }); h.git('add', '.');
  const review = await readWorkspaceChanges(h.root);
  assert.ok(review.files.every(file => !file.omittedReason));
  const applyRoot = await mkdtemp(join(tmpdir(), 'dot-apply-special-')); t.after(() => rm(applyRoot, { recursive: true, force: true }));
  for (const [path, text] of initial) await writeFile(join(applyRoot, path), text);
  await chmod(join(applyRoot, 'delete.ts'), 0o755);
  execFileSync('git', ['apply', '--no-index', '-'], { cwd: applyRoot, input: review.files.map(file => file.stagedDiff).join('') });
  for (const path of ['quote " 中.ts', 'new name.ts', 'mode.ts', 'empty-new.ts', 'run.ts']) {
    assert.equal(await readFile(join(applyRoot, path), 'utf8'), await readFile(join(h.root, path), 'utf8'));
    assert.equal((await stat(join(applyRoot, path))).mode & 0o100, (await stat(join(h.root, path))).mode & 0o100);
  }
  for (const path of ['old.ts', 'delete.ts', 'empty-deleted.ts']) await assert.rejects(readFile(join(applyRoot, path)), { code: 'ENOENT' });
});
