import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import type { ConsumptionRange, SourceId, WorkspaceConsumptionRow } from '../shared/consumption';
import { parseCcusage, runCcusage, runCcusageCommand } from './ccusage';
import { runPi } from './pi';
import { runAntigravity } from './antigravity';
import type { WorkspaceResolver } from './workspace-catalog';
import { readReconciledWorkspace, workspaceTotalsMatch } from './workspace-reconciliation';
import { deduplicateCodexSessions, type CodexSessionCandidate } from './codex-session-copies';
export { reconcileWorkspaceRows } from './workspace-reconciliation';

function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw new Error('读取已取消');
}

function roots(source: 'codex' | 'kimi', env: NodeJS.ProcessEnv): string[] {
  const configured = source === 'codex' ? env.CODEX_HOME : env.KIMI_DATA_DIR;
  return configured ? configured.split(',').map(path => path.trim()).filter(Boolean) : source === 'codex' ? [join(homedir(), '.codex')] : [join(homedir(), '.kimi'), join(homedir(), '.kimi-code')];
}
async function codexMetadata(id: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ id?: string; cwd?: string; path?: string }> {
  for (const root of roots('codex', env)) for (const directory of [join(root, 'sessions'), join(root, 'archived_sessions'), root]) {
    const path = resolve(directory, `${id}.jsonl`), rel = relative(resolve(directory), path);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    // Session metadata is at the start. Bound reads and never return chat content.
    const input = createReadStream(path, { encoding: 'utf8', end: 256 * 1024, signal });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('session_meta')) continue;
        const entry = JSON.parse(line);
        if (entry.type === 'session_meta') return { path, id: typeof entry.payload?.id === 'string' ? entry.payload.id : undefined, cwd: typeof entry.payload?.cwd === 'string' ? entry.payload.cwd : undefined };
      }
    } catch { checkSignal(signal); }
    finally { lines.close(); input.destroy(); }
  }
  return {};
}
async function kimiDirectories(env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const result = new Map<string, string | undefined>();
  for (const root of roots('kimi', env)) {
    const base = join(root, 'sessions');
    for (const group of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (!group.isDirectory()) continue;
      for (const session of await readdir(join(base, group.name), { withFileTypes: true }).catch(() => [])) {
        checkSignal(signal);
        if (!session.isDirectory()) continue;
        try {
          const state = JSON.parse(await readFile(join(base, group.name, session.name, 'state.json'), { encoding: 'utf8', signal }));
          if (typeof state.cwd === 'string') result.set(session.name, result.has(session.name) && result.get(session.name) !== state.cwd ? undefined : state.cwd);
        } catch { checkSignal(signal); }
      }
    }
  }
  return result;
}

export async function readWorkspaceSource(source: SourceId, range: ConsumptionRange, signal: AbortSignal, catalog: WorkspaceResolver, env: NodeJS.ProcessEnv = process.env) {
  if (source === 'pi' || source === 'antigravity') {
    const result = source === 'pi'
      ? await runPi(range, signal, undefined, (id, cwd) => catalog.session(source, id, cwd))
      : await runAntigravity(range, signal, undefined, id => catalog.session(source, id));
    return { ...result, workspaceRows: result.rows.map(({ date, ...row }) => row) };
  }
  return readReconciledWorkspace(() => runCcusage(source, range, signal, env), async dailyRows => {
    const readStartedAt = Date.now();
    const detail = await runCcusageCommand(source, source === 'claude' ? 'projects' : 'session', range, signal, env);
    const raw = detail.json as Record<string, unknown>, candidates: WorkspaceConsumptionRow[] = [];
    if (source === 'claude') {
      if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) throw new Error('Invalid projects');
      for (const [project, daily] of Object.entries(raw.projects)) {
        const workspace = catalog.claudeProject(project);
        for (const { date, ...row } of parseCcusage({ daily }, range)) candidates.push({ ...row, ...(workspace ? { workspace } : {}) });
      }
    } else {
      if (!Array.isArray(raw.sessions)) throw new Error('Invalid sessions');
      const directories = source === 'kimi' ? await kimiDirectories(env, signal) : undefined;
      const codexSessions: CodexSessionCandidate[] = [];
      for (const session of raw.sessions) {
        checkSignal(signal);
        if (typeof session?.sessionId !== 'string') throw new Error('Invalid session');
        const metadata = source === 'codex' ? await codexMetadata(session.sessionId, env, signal) : { id: session.sessionId, cwd: directories?.get(session.sessionId) ?? (typeof session.projectPath === 'string' ? session.projectPath : undefined) };
        const workspace = catalog.session(source, metadata.id, metadata.cwd);
        // Reuse token validation only; session totals have no artificial daily date in the RPC.
        const rows = parseCcusage({ daily: [{ ...session, date: range.since }] }, range).map(({ date, ...row }) => ({ ...row, ...(workspace ? { workspace } : {}) }));
        candidates.push(...rows);
        if (source === 'codex') codexSessions.push({ ...metadata, rows });
      }
      if (source === 'codex' && !workspaceTotalsMatch(dailyRows, candidates)) return { rows: await deduplicateCodexSessions(codexSessions, readStartedAt, signal), message: detail.message };
    }
    return { rows: candidates, message: detail.message };
  }, signal);
}
