import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { WorkspaceConsumptionRow } from '../shared/consumption';

export type CodexSessionCandidate = { id?: string; path?: string; rows: WorkspaceConsumptionRow[] };

async function fingerprint(path: string, readStartedAt: number, signal: AbortSignal): Promise<string | undefined> {
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    // A growing or replaced log cannot prove what the collector saw earlier in this scan.
    if (!before.isFile() || before.mtimeMs >= readStartedAt || before.ctimeMs >= readStartedAt) return;
    const hash = createHash('sha256'), input = file.createReadStream({ autoClose: false, signal });
    for await (const chunk of input) hash.update(chunk);
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return;
    return hash.digest('hex');
  } finally { await file.close(); }
}

/** Remove only proven, unchanged byte-for-byte copies of the same session. */
export async function deduplicateCodexSessions(sessions: CodexSessionCandidate[], readStartedAt: number, signal: AbortSignal): Promise<WorkspaceConsumptionRow[]> {
  const groups = new Map<string, CodexSessionCandidate[]>();
  for (const session of sessions) {
    const summary = session.rows.map(row => [row.model, row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning, row.inferredModel, row.workspace?.id ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const key = session.id && session.path ? JSON.stringify([session.id, summary]) : JSON.stringify(['unknown', groups.size]);
    const group = groups.get(key) ?? []; group.push(session); groups.set(key, group);
  }
  const result: WorkspaceConsumptionRow[] = [];
  for (const group of groups.values()) {
    const seen = new Set<string>();
    for (const session of group) {
      if (signal.aborted) throw new Error('读取已取消');
      let digest: string | undefined;
      if (group.length > 1 && session.path) {
        try { digest = await fingerprint(session.path, readStartedAt, signal); }
        catch { if (signal.aborted) throw new Error('读取已取消'); }
      }
      if (digest && seen.has(digest)) continue;
      if (digest) seen.add(digest);
      result.push(...session.rows);
    }
  }
  return result;
}
