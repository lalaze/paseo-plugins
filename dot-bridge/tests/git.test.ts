import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';
import { createGit, prMatchesTask } from '../server/git';

const exec = promisify(execFile);
const scratch: string[] = [];
after(() => Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true }))));

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd, encoding: 'utf8' });
  return String(result.stdout ?? '').trim();
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

interface Fixture {
  remote: string;
  work: string;
  baseSha: string;
  headSha: string;
  branch: string;
}

async function fixture(): Promise<Fixture> {
  const remote = await tempDir('dot-remote-');
  const work = await tempDir('dot-work-');
  await git(remote, ['init', '--bare', '-b', 'main']);
  await git(work, ['init', '-b', 'main']);
  await git(work, ['config', 'user.email', 'test@example.com']);
  await git(work, ['config', 'user.name', 'test']);
  await writeFile(join(work, 'note.txt'), 'base\n');
  await git(work, ['add', 'note.txt']);
  await git(work, ['commit', '-m', 'base']);
  const baseSha = await git(work, ['rev-parse', 'HEAD']);
  await git(work, ['remote', 'add', 'origin', remote]);
  await git(work, ['push', 'origin', 'main']);
  const branch = 'dot/task-1';
  await git(work, ['checkout', '-b', branch]);
  await writeFile(join(work, 'note.txt'), 'changed\n');
  await writeFile(join(work, 'added.txt'), 'new\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '-m', 'change']);
  const headSha = await git(work, ['rev-parse', 'HEAD']);
  await git(work, ['push', 'origin', branch]);
  return { remote, work, baseSha, headSha, branch };
}

describe('git verification', () => {
  it('verifies a delivered branch, its files and diff', async () => {
    const fx = await fixture();
    const port = createGit({ cacheRoot: await tempDir('dot-cache-'), now: () => 42 });
    const result = await port.verifyResult({ remote: fx.remote, branch: fx.branch, baseSha: fx.baseSha, headSha: fx.headSha, taskBranch: fx.branch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.branchHead, fx.headSha);
    assert.deepEqual(result.files.sort(), ['added.txt', 'note.txt']);
    assert.match(result.patch, /changed/);
    assert.equal(result.verifiedAt, 42);
  });

  it('reports branch-moved when the remote branch moved past the reported head', async () => {
    const fx = await fixture();
    await writeFile(join(fx.work, 'later.txt'), 'later\n');
    await git(fx.work, ['add', '.']);
    await git(fx.work, ['commit', '-m', 'later']);
    await git(fx.work, ['push', 'origin', fx.branch]);
    const port = createGit({ cacheRoot: await tempDir('dot-cache-'), now: () => 42 });
    const result = await port.verifyResult({ remote: fx.remote, branch: fx.branch, baseSha: fx.baseSha, headSha: fx.headSha, taskBranch: fx.branch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'branch-moved');
  });

  it('rejects a branch that is not the task branch', async () => {
    const fx = await fixture();
    const port = createGit({ cacheRoot: await tempDir('dot-cache-'), now: () => 42 });
    const result = await port.verifyResult({ remote: fx.remote, branch: fx.branch, baseSha: fx.baseSha, headSha: fx.headSha, taskBranch: 'dot/other' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'branch-not-task');
  });

  it('rejects a base that is not an ancestor of the head', async () => {
    const fx = await fixture();
    // A second root commit shares no ancestry with the task branch.
    await git(fx.work, ['checkout', '--orphan', 'side']);
    await git(fx.work, ['rm', '-rf', '.']);
    await writeFile(join(fx.work, 'other.txt'), 'other\n');
    await git(fx.work, ['add', '.']);
    await git(fx.work, ['commit', '-m', 'side']);
    const side = await git(fx.work, ['rev-parse', 'HEAD']);
    await git(fx.work, ['push', 'origin', 'side']);
    const port = createGit({ cacheRoot: await tempDir('dot-cache-'), now: () => 42 });
    const result = await port.verifyResult({ remote: fx.remote, branch: fx.branch, baseSha: side, headSha: fx.headSha, taskBranch: fx.branch });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.code === 'not-ancestor' || result.code === 'base-unreachable');
  });

  it('reads a pushed base as reachable and an unknown sha as unreachable', async () => {
    const fx = await fixture();
    const port = createGit({ cacheRoot: await tempDir('dot-cache-'), now: () => 42 });
    assert.equal(await port.baseReachable(fx.remote, fx.baseSha), true);
    assert.equal(await port.baseReachable(fx.remote, 'f'.repeat(40)), false);
  });

  it('does not treat a cached base as reachable once the remote is gone', async () => {
    const fx = await fixture();
    const port = createGit({ cacheRoot: await tempDir('dot-cache-'), now: () => 42 });
    // Prime the cache, then make the remote unreachable.
    assert.equal(await port.baseReachable(fx.remote, fx.baseSha), true);
    const gone = `${fx.remote}-gone`;
    await rename(fx.remote, gone);
    try {
      assert.equal(await port.baseReachable(fx.remote, fx.baseSha), false);
    } finally {
      await rename(gone, fx.remote);
    }
  });

  it('does not treat a cached base as reachable once the remote no longer serves it', async () => {
    const fx = await fixture();
    const port = createGit({ cacheRoot: await tempDir('dot-cache-'), now: () => 42 });
    // Prime the cache while the remote still serves the commit.
    assert.equal(await port.baseReachable(fx.remote, fx.baseSha), true);
    // Delete every ref on the remote and drop the objects, so the commit is no longer obtainable.
    await git(fx.remote, ['update-ref', '-d', 'refs/heads/main']);
    await git(fx.remote, ['update-ref', '-d', `refs/heads/${fx.branch}`]);
    await git(fx.remote, ['reflog', 'expire', '--expire=now', '--all']);
    await git(fx.remote, ['gc', '--prune=now']);
    assert.equal(await port.baseReachable(fx.remote, fx.baseSha), false);
  });

  it('treats a base reachable only through a tag as reachable even when it is cached', async () => {
    const fx = await fixture();
    const port = createGit({ cacheRoot: await tempDir('dot-cache-'), now: () => 42 });
    // Prime the cache while the branch still exists.
    assert.equal(await port.baseReachable(fx.remote, fx.baseSha), true);
    // Now make the base reachable only through a tag; the cached object alone must not decide.
    await git(fx.remote, ['update-ref', '-d', 'refs/heads/main']);
    await git(fx.remote, ['update-ref', '-d', `refs/heads/${fx.branch}`]);
    await git(fx.remote, ['update-ref', 'refs/tags/phase0-base', fx.baseSha]);
    assert.equal(await port.baseReachable(fx.remote, fx.baseSha), true);
  });

  it('inspects a repository without changing it', async () => {
    const fx = await fixture();
    const port = createGit({ cacheRoot: await tempDir('dot-cache-'), now: () => 42 });
    const before = await git(fx.work, ['rev-parse', 'HEAD']);
    const inspection = await port.inspectRepository(fx.work);
    assert.equal(inspection.remotes[0].name, 'origin');
    assert.equal(inspection.dirty, false);
    assert.equal(await git(fx.work, ['rev-parse', 'HEAD']), before);
  });
});

describe('pull request matching', () => {
  const remote = 'https://github.com/acme/repo.git';
  const branch = 'dot/task-1';
  const head = '2'.repeat(40);
  it('checks repository identity only, ignoring untrusted URL query parameters', () => {
    assert.equal(prMatchesTask(null, remote, branch, head), true);
    assert.equal(prMatchesTask('https://github.com/acme/repo/pull/7', remote, branch, head), true);
    // Query parameters are attacker-controlled and never used for the identity decision.
    assert.equal(prMatchesTask('https://github.com/acme/repo/pull/7?head=dot/other', remote, branch, head), true);
    assert.equal(prMatchesTask('https://github.com/other/repo/pull/7', remote, branch, head), false);
    // Same owner, different repository must not match.
    assert.equal(prMatchesTask('https://github.com/acme/other/pull/7', remote, branch, head), false);
    assert.equal(prMatchesTask('https://evil.example.com/acme/repo/pull/7', remote, branch, head), false);
    assert.equal(prMatchesTask('https://github.com/acme/repo/issues/7', remote, branch, head), false);
  });

  it('confirms the real PR head through the provider API, not the URL', async () => {
    const facts = { headRef: branch, headSha: head, baseRepo: 'acme/repo', headRepo: 'acme/repo', fork: false };
    const accepting = createGit({ cacheRoot: await tempDir('dot-cache-'), prLookup: async () => facts });
    assert.equal(await accepting.prMatches({ prUrl: null, remote, taskBranch: branch, headSha: head }), true);
    assert.equal(await accepting.prMatches({ prUrl: 'https://github.com/acme/repo/pull/7?head=dot/other', remote, taskBranch: branch, headSha: head }), true);
    // A real fork PR whose head branch name differs is refused.
    const forked = createGit({ cacheRoot: await tempDir('dot-cache-'), prLookup: async () => ({ ...facts, headRef: 'feature' }) });
    assert.equal(await forked.prMatches({ prUrl: 'https://github.com/acme/repo/pull/7', remote, taskBranch: branch, headSha: head }), false);
    // A fork PR whose head ref and sha match but whose head repository differs is refused.
    const forkRepo = createGit({ cacheRoot: await tempDir('dot-cache-'), prLookup: async () => ({ ...facts, headRepo: 'evil/fork', fork: true }) });
    assert.equal(await forkRepo.prMatches({ prUrl: 'https://github.com/acme/repo/pull/7', remote, taskBranch: branch, headSha: head }), false);
    // A moved head commit is refused.
    const moved = createGit({ cacheRoot: await tempDir('dot-cache-'), prLookup: async () => ({ ...facts, headSha: '3'.repeat(40) }) });
    assert.equal(await moved.prMatches({ prUrl: 'https://github.com/acme/repo/pull/7', remote, taskBranch: branch, headSha: head }), false);
    // A PR targeting another repository is refused.
    const other = createGit({ cacheRoot: await tempDir('dot-cache-'), prLookup: async () => ({ ...facts, baseRepo: 'acme/other' }) });
    assert.equal(await other.prMatches({ prUrl: 'https://github.com/acme/repo/pull/7', remote, taskBranch: branch, headSha: head }), false);
    // An unreachable/unknown provider result is refused.
    const missing = createGit({ cacheRoot: await tempDir('dot-cache-'), prLookup: async () => null });
    assert.equal(await missing.prMatches({ prUrl: 'https://github.com/acme/repo/pull/7', remote, taskBranch: branch, headSha: head }), false);
  });
});

describe('github PR provider parsing', () => {
  const remote = 'https://github.com/acme/repo.git';
  const branch = 'dot/task-1';
  const head = '2'.repeat(40);
  const base = 'a'.repeat(40);

  function withFetch(payload: unknown, status = 200) {
    return createGit({ cacheRoot: '/tmp/unused-dot-cache', fetchImpl: async () => new Response(JSON.stringify(payload), { status }) });
  }

  it('accepts a full GitHub PR payload and ignores the fields it does not read', async () => {
    // A realistic GitHub response, including the many fields the bridge never uses.
    const payload = {
      id: 123456,
      number: 7,
      state: 'open',
      html_url: 'https://github.com/acme/repo/pull/7',
      user: { login: 'octocat', id: 1 },
      _links: { self: { href: 'https://api.github.com/repos/acme/repo/pulls/7' } },
      head: {
        label: 'acme:dot/task-1',
        ref: branch,
        sha: head,
        user: { login: 'octocat' },
        repo: { id: 99, name: 'repo', full_name: 'acme/repo', private: false, owner: { login: 'acme' } },
      },
      base: {
        label: 'acme:main',
        ref: 'main',
        sha: base,
        repo: { id: 99, name: 'repo', full_name: 'acme/repo', private: false },
      },
    };
    const port = withFetch(payload);
    assert.equal(await port.prMatches({ prUrl: 'https://github.com/acme/repo/pull/7', remote, taskBranch: branch, headSha: head }), true);
  });

  it('fails closed when head.repo is missing or the head lives in a fork', async () => {
    const noHeadRepo = { head: { ref: branch, sha: head, repo: null }, base: { repo: { full_name: 'acme/repo' } } };
    assert.equal(
      await withFetch(noHeadRepo).prMatches({ prUrl: 'https://github.com/acme/repo/pull/7', remote, taskBranch: branch, headSha: head }),
      false,
    );
    const fork = {
      head: { ref: branch, sha: head, repo: { full_name: 'evil/fork' } },
      base: { repo: { full_name: 'acme/repo' } },
    };
    assert.equal(
      await withFetch(fork).prMatches({ prUrl: 'https://github.com/acme/repo/pull/7', remote, taskBranch: branch, headSha: head }),
      false,
    );
  });
});
