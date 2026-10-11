import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { dotBridgeError } from '../shared/errors';
import { withTimeout, type FetchLike } from './http';

const exec = promisify(execFile);
const DIFF_LIMIT = 200_000;
/** The provider PR lookup is bounded so a hung GitHub request cannot stall a verification. */
const PR_TIMEOUT_MS = 15_000;

/**
 * Cache writes are serialized per (cacheRoot, remote) across every createGit instance, so two
 * handlers that each build their own port still cannot race the same bare cache.
 */
const cacheLocks = new Map<string, Promise<unknown>>();

function serializeCache<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = cacheLocks.get(key) ?? Promise.resolve();
  const next = previous.then(job, job);
  cacheLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRun = (cwd: string, args: string[], env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<GitResult>;

/** Git is always called with an argv array, never a shell string. */
export const defaultGitRun: GitRun = async (cwd, args, env, signal) => {
  try {
    const result = await exec('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
      killSignal: 'SIGKILL',
      signal,
    });
    return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: unknown; stderr?: unknown; name?: string };
    // An aborted run is a lifecycle shutdown, not a git failure to report as a result.
    if (failed.name === 'AbortError') throw error;
    if (typeof failed.code === 'number') return { code: failed.code, stdout: String(failed.stdout ?? ''), stderr: String(failed.stderr ?? '') };
    throw error;
  }
};

export interface RepositoryInspection {
  directory: string | null;
  remotes: Array<{ name: string; url: string }>;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  unpushed: boolean;
}

export interface VerifyInput {
  remote: string;
  branch: string;
  baseSha: string;
  headSha: string;
  /** Expected task branch. A mismatch means the result belongs to a different task. */
  taskBranch: string;
}

export interface VerifySuccess {
  ok: true;
  files: string[];
  patch: string;
  truncated: boolean;
  /** The branch head observed while fetching. */
  branchHead: string;
  verifiedAt: number;
}

export interface VerifyFailure {
  ok: false;
  code: 'branch-not-task' | 'head-unreachable' | 'branch-moved' | 'base-mismatch' | 'base-unreachable' | 'not-ancestor' | 'git-failed';
  detail: string;
}

export type VerifyResult = VerifySuccess | VerifyFailure;

export interface PrMatchInput {
  prUrl: string | null;
  remote: string;
  taskBranch: string;
  headSha: string;
}

export interface GitPort {
  inspectRepository(directory: string): Promise<RepositoryInspection>;
  resolveRepository(directory: string): Promise<string>;
  verifyResult(input: VerifyInput): Promise<VerifyResult>;
  /** True when the commit can be read from the bound remote (a fetch is attempted first). */
  baseReachable(remote: string, sha: string): Promise<boolean>;
  /** Confirms the PR belongs to the bound repo and its real head is the task branch and commit. */
  prMatches(input: PrMatchInput): Promise<boolean>;
}

export interface GitOptions {
  run?: GitRun;
  cacheRoot: string;
  now?: () => number;
  /** How PR metadata is fetched; defaults to the GitHub REST API. */
  prLookup?: PrLookup;
  fetchImpl?: FetchLike;
  githubToken?: string;
  /** Aborted on plugin unload so a long fetch is killed instead of outliving the contribution. */
  signal?: AbortSignal;
}

export function createGit(options: GitOptions): GitPort {
  const run = options.run ?? defaultGitRun;
  const now = options.now ?? (() => Date.now());
  const prLookup = options.prLookup ?? githubPrLookup(options.fetchImpl, options.githubToken, options.signal);

  function cacheDirFor(remote: string): string {
    const hash = createHash('sha256').update(remote).digest('hex').slice(0, 24);
    return join(options.cacheRoot, `${hash}.git`);
  }

  /** The lock key includes the cache root so two data dirs never block each other. */
  function lockKey(remote: string): string {
    return `${options.cacheRoot}\n${remote}`;
  }

  async function git(cwd: string, args: string[]): Promise<GitResult> {
    if (options.signal?.aborted) throw dotBridgeError('git-failed', 'aborted');
    return run(cwd, args, undefined, options.signal);
  }

  async function mustGit(cwd: string, args: string[]): Promise<string> {
    const result = await git(cwd, args);
    if (result.code !== 0) throw dotBridgeError('git-failed', `git ${args.join(' ')}: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout.trim();
  }

  async function ensureCache(remote: string): Promise<string> {
    const dir = cacheDirFor(remote);
    if (!existsSync(join(dir, 'HEAD'))) {
      await mkdir(options.cacheRoot, { recursive: true });
      await mustGit(options.cacheRoot, ['init', '--bare', dir]);
    }
    const listed = await git(dir, ['remote', 'get-url', 'origin']);
    if (listed.code !== 0) await mustGit(dir, ['remote', 'add', 'origin', remote]);
    else if (listed.stdout.trim() !== remote) await mustGit(dir, ['remote', 'set-url', 'origin', remote]);
    return dir;
  }

  async function resolveRepository(directory: string): Promise<string> {
    const result = await git(directory, ['rev-parse', '--show-toplevel']);
    if (result.code !== 0) throw dotBridgeError('workspace-missing', directory);
    return result.stdout.trim();
  }

  async function inspectRepository(directory: string): Promise<RepositoryInspection> {
    const top = await git(directory, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) {
      return { directory: null, remotes: [], branch: null, head: null, dirty: false, unpushed: false };
    }
    const root = top.stdout.trim();
    const remoteOut = await mustGit(root, ['remote', '-v']).catch(() => '');
    const remotes: Array<{ name: string; url: string }> = [];
    for (const line of remoteOut.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      if (match) remotes.push({ name: match[1], url: match[2] });
    }
    const branchOut = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const headOut = await git(root, ['rev-parse', 'HEAD']);
    const statusOut = await git(root, ['status', '--porcelain']);
    const upstream = await git(root, ['rev-list', '--count', '@{u}..HEAD']);
    return {
      directory: root,
      remotes,
      branch: branchOut.code === 0 ? branchOut.stdout.trim() : null,
      head: headOut.code === 0 ? headOut.stdout.trim() : null,
      dirty: statusOut.code === 0 ? statusOut.stdout.trim().length > 0 : false,
      unpushed: upstream.code === 0 ? Number(upstream.stdout.trim() || '0') > 0 : true,
    };
  }

  async function verifyResult(input: VerifyInput): Promise<VerifyResult> {
    if (input.branch !== input.taskBranch) return { ok: false, code: 'branch-not-task', detail: `${input.branch} != ${input.taskBranch}` };
    return serializeCache(lockKey(input.remote), async () => {
      let dir: string;
      try {
        dir = await ensureCache(input.remote);
      } catch (error) {
        return { ok: false, code: 'git-failed', detail: error instanceof Error ? error.message : String(error) };
      }
      const refspec = `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`;
      const fetched = await git(dir, ['fetch', '--no-tags', '--prune', 'origin', refspec]);
      if (fetched.code !== 0) return { ok: false, code: 'git-failed', detail: fetched.stderr.trim() || 'fetch failed' };

      const remoteRef = `refs/remotes/origin/${input.branch}`;
      const branchHead = await git(dir, ['rev-parse', remoteRef]);
      if (branchHead.code !== 0) return { ok: false, code: 'head-unreachable', detail: `branch ${input.branch} is not on the remote` };
      const observed = branchHead.stdout.trim();
      if (observed !== input.headSha) return { ok: false, code: 'branch-moved', detail: `remote branch is at ${observed}` };

      const hasHead = await git(dir, ['cat-file', '-e', `${input.headSha}^{commit}`]);
      if (hasHead.code !== 0) return { ok: false, code: 'head-unreachable', detail: input.headSha };
      const hasBase = await git(dir, ['cat-file', '-e', `${input.baseSha}^{commit}`]);
      if (hasBase.code !== 0) return { ok: false, code: 'base-unreachable', detail: input.baseSha };

      const ancestor = await git(dir, ['merge-base', '--is-ancestor', input.baseSha, input.headSha]);
      if (ancestor.code !== 0) return { ok: false, code: 'not-ancestor', detail: `${input.baseSha} is not an ancestor of ${input.headSha}` };

      const names = await git(dir, ['diff', '--name-only', input.baseSha, input.headSha]);
      if (names.code !== 0) return { ok: false, code: 'git-failed', detail: names.stderr.trim() || 'diff --name-only failed' };
      const diff = await git(dir, ['diff', '--no-color', input.baseSha, input.headSha]);
      if (diff.code !== 0) return { ok: false, code: 'git-failed', detail: diff.stderr.trim() || 'diff failed' };
      const patch = diff.stdout;
      return {
        ok: true,
        files: names.stdout.split('\n').map(line => line.trim()).filter(Boolean),
        patch: patch.slice(0, DIFF_LIMIT),
        truncated: patch.length > DIFF_LIMIT,
        branchHead: observed,
        verifiedAt: now(),
      };
    });
  }

  /**
   * True when the bound remote can currently serve the commit. When the object is not yet cached a
   * successful `fetch <sha>` proves the remote answered; when it is already cached the fetch would
   * short-circuit, so an isolated fetch into a fresh bare repo (no pre-existing object) is used. A
   * commit that only survives in the local cache is therefore never reported reachable.
   */
  async function baseReachable(remote: string, sha: string): Promise<boolean> {
    return serializeCache(lockKey(remote), async () => {
      let dir: string;
      try {
        dir = await ensureCache(remote);
      } catch {
        return false;
      }
      const cached = await git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
      if (cached.code !== 0) {
        const fetched = await git(dir, ['fetch', '--no-tags', '--force', 'origin', sha]);
        if (fetched.code !== 0) return false;
        const has = await git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
        return has.code === 0;
      }
      return remoteServes(remote, sha);
    });
  }

  /**
   * Proves the remote can serve `sha` with an isolated fetch into a brand-new bare repository, so no
   * pre-existing local object can satisfy the request. Every legal ref is fetched — branches *and*
   * tags — because a base commit may be reachable only through a tag; fetching branches alone would
   * wrongly report a tag-only base as gone. Objects no longer reachable from any advertised ref
   * cannot be fetched, which is exactly the case where the base has become unavailable.
   */
  async function remoteServes(remote: string, sha: string): Promise<boolean> {
    let dir: string | null = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'dot-probe-'));
      await mustGit(tmpdir(), ['init', '--bare', dir]);
      await mustGit(dir, ['remote', 'add', 'origin', remote]);
      const fetched = await git(dir, ['fetch', '--force', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']);
      if (fetched.code !== 0) return false;
      const has = await git(dir, ['cat-file', '-e', `${sha}^{commit}`]);
      return has.code === 0;
    } catch {
      return false;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Identity first (host/owner/repo), then the real PR head from the provider API. */
  async function prMatches(input: PrMatchInput): Promise<boolean> {
    if (!input.prUrl) return true;
    const repo = parseRemote(input.remote);
    if (!repo) return false;
    const identity = parsePrUrl(input.prUrl);
    if (!identity) return false;
    if (identity.host !== repo.host) return false;
    if (identity.owner !== repo.owner || identity.repo !== repo.repo) return false;
    const facts = await prLookup(identity).catch(() => null);
    if (!facts) return false;
    const bound = `${repo.owner}/${repo.repo}`;
    if (facts.baseRepo !== bound) return false;
    // The head branch must live in the bound repository too: a fork PR is refused even when its ref
    // and sha happen to match. A missing or abnormal head repo fails closed.
    if (facts.headRepo !== bound) return false;
    if (facts.fork) return false;
    if (facts.headRef !== input.taskBranch) return false;
    if (facts.headSha !== input.headSha) return false;
    return true;
  }

  return { inspectRepository, resolveRepository, verifyResult, baseReachable, prMatches };
}

/** Parses an HTTPS or SSH git remote into a host/owner/repo identity. */
function parseRemote(remote: string): { host: string; owner: string; repo: string } | null {
  const trimmed = remote.trim().replace(/\.git$/, '');
  if (!trimmed.includes('://')) {
    const ssh = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(trimmed);
    if (ssh) {
      const parts = ssh[2].split('/').filter(Boolean);
      if (parts.length >= 2) {
        return { host: ssh[1].toLowerCase(), owner: parts[parts.length - 2].toLowerCase(), repo: parts[parts.length - 1].toLowerCase() };
      }
    }
    return null;
  }
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return { host: url.hostname.toLowerCase(), owner: parts[parts.length - 2].toLowerCase(), repo: parts[parts.length - 1].toLowerCase() };
    }
  } catch {
    return null;
  }
  return null;
}

export interface PrIdentity {
  host: string;
  owner: string;
  repo: string;
  number: string;
}

/** Extracts the repository identity and PR number from a pull-request URL. */
export function parsePrUrl(prUrl: string): PrIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(prUrl);
  } catch {
    return null;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const [owner, repo, kind, number] = parts;
  if (kind !== 'pull' || !/^\d+$/.test(number)) return null;
  return { host: parsed.hostname.toLowerCase(), owner: owner.toLowerCase(), repo: repo.toLowerCase(), number };
}

export interface PrFacts {
  headRef: string;
  headSha: string;
  /** `owner/name` of the repository the PR targets. */
  baseRepo: string;
  /** `owner/name` of the repository the PR head branch lives in; a fork differs from the base. */
  headRepo: string;
  /** The provider marks the head as coming from a fork. */
  fork: boolean;
}

export type PrLookup = (identity: PrIdentity) => Promise<PrFacts | null>;

/**
 * The subset of the provider PR payload we trust, validated before any field is used. The objects
 * are deliberately not `.strict()`: GitHub returns many fields we do not read (`id`, `number`,
 * `state`, `html_url`, `head.label`, `repo.id`, `repo.private`, …) and rejecting a legitimate PR
 * because of an unrelated field would fail delivery verification. Zod strips the unknown keys, so
 * only the fields below reach the caller. Missing/abnormal `head.repo` still fails closed.
 */
const prResponseSchema = z.object({
  head: z.object({
    ref: z.string().min(1).max(400),
    sha: z.string().min(7).max(64),
    repo: z.object({ full_name: z.string().min(3).max(400) }).nullable(),
  }),
  base: z.object({
    repo: z.object({ full_name: z.string().min(3).max(400) }).nullable(),
  }),
});

/**
 * Reads the real head ref and commit from the GitHub REST API. Query parameters on the PR URL are
 * never trusted, because anyone can add them. The provider payload is Zod-validated and both the
 * head and base repositories must be present; a fork PR is detected by comparing the two. Non-GitHub
 * hosts cannot be verified and return null. The request is bounded by a timeout and the lifecycle
 * signal, so a hung provider cannot stall the bridge.
 */
export function githubPrLookup(fetchImpl?: FetchLike, token?: string, signal?: AbortSignal): PrLookup {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  return async identity => {
    if (identity.host !== 'github.com') return null;
    const timeout = withTimeout(signal, PR_TIMEOUT_MS);
    let body: unknown;
    try {
      const response = await doFetch(`https://api.github.com/repos/${identity.owner}/${identity.repo}/pulls/${identity.number}`, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'paseo-dot-bridge',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal: timeout.signal,
      });
      if (response.status < 200 || response.status >= 300) return null;
      body = await response.json();
    } catch {
      return null;
    } finally {
      timeout.clear();
    }
    const parsed = prResponseSchema.safeParse(body);
    if (!parsed.success) return null;
    const headRepo = parsed.data.head.repo?.full_name;
    const baseRepo = parsed.data.base.repo?.full_name;
    if (!headRepo || !baseRepo) return null;
    const head = headRepo.toLowerCase();
    const base = baseRepo.toLowerCase();
    return {
      headRef: parsed.data.head.ref,
      headSha: parsed.data.head.sha,
      baseRepo: base,
      headRepo: head,
      fork: head !== base,
    };
  };
}

/**
 * Pure identity check: the PR URL must point at the same host, owner and repository as the bound
 * remote. The real head branch/commit are confirmed separately by `prMatches`, never from the URL.
 */
export function prMatchesTask(prUrl: string | null, remote: string, _taskBranch: string, _headSha: string): boolean {
  if (!prUrl) return true;
  const repo = parseRemote(remote);
  if (!repo) return false;
  const identity = parsePrUrl(prUrl);
  if (!identity) return false;
  return identity.host === repo.host && identity.owner === repo.owner && identity.repo === repo.repo;
}
