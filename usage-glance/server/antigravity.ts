import { DatabaseSync } from 'node:sqlite';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { addTokens, dateInZone, emptyTokens, type ConsumptionRange, type ConsumptionRow, type WorkspaceIdentity } from '../shared/consumption';
import { dedupeAgy, generationMetadata, stepMetadata, trajectoryTimestamp, type AgyEvent, type AgyMetadata } from './antigravity-proto';

export function antigravityRoots(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  return env.ANTIGRAVITY_DATA_DIR?.trim() ? env.ANTIGRAVITY_DATA_DIR.split(',').map(value => value.trim()).filter(Boolean) : [
    ...['antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-backup'].map(name => join(home, '.gemini', name)), join(home, '.config', 'antigravity'),
  ];
}
function readDatabase(path: string): { events: AgyEvent[]; warnings: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
    if (!tables.has('gen_metadata')) throw new Error('数据库缺少生成用量');
    let fallback: number | undefined, warnings = 0;
    if (tables.has('trajectory_metadata_blob')) for (const row of db.prepare('SELECT data FROM trajectory_metadata_blob ORDER BY rowid').iterate()) {
      try { fallback ??= trajectoryTimestamp(row.data as Uint8Array); } catch { warnings++; }
    }
    const parsed: { metadata: AgyMetadata; identity: string }[] = [];
    let model: string | undefined;
    // A malformed row cannot hide the error or prevent unrelated valid rows being shown.
    for (const row of db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').iterate()) {
      try {
        const metadata = generationMetadata(row.data as Uint8Array);
        model = metadata.model ?? model;
        parsed.push({ metadata: { ...metadata, model }, identity: `gen:${basename(path)}:${row.idx}` });
      } catch { warnings++; }
    }
    if (tables.has('steps')) for (const row of db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx').iterate()) {
      try { parsed.push({ metadata: stepMetadata(row.metadata as Uint8Array), identity: `step:${basename(path)}:${row.idx}` }); } catch { warnings++; }
    }
    const hasGenerations = parsed.some(value => value.identity.startsWith('gen:') && value.metadata.usages.length);
    const events = parsed.flatMap(({ metadata, identity }) => metadata.usages.flatMap((usage, index): AgyEvent[] => {
      // Unidentified steps cannot safely be added to generation totals. Report the
      // gap instead of guessing whether this is a duplicate or another request.
      if (hasGenerations && identity.startsWith('step:') && !usage.identities.length) { warnings++; return []; }
      const model = usage.model && !/^antigravity-model-/.test(usage.model) ? usage.model : metadata.model ?? usage.model ?? '未记录模型';
      return [{ ...usage, model, time: metadata.time ?? fallback, timeRank: metadata.time !== undefined ? 2 : fallback !== undefined ? 1 : 0,
        // Row identities deduplicate backup copies when server IDs are absent.
        identities: usage.identities.length ? usage.identities : [`row:${identity}:${index}:${createHash('sha256').update(JSON.stringify(usage)).digest('hex')}`],
      }];
    }));
    db.exec('ROLLBACK');
    return { events, warnings };
  } finally { db.close(); }
}

export async function runAntigravity(range: ConsumptionRange, signal: AbortSignal, roots = antigravityRoots(), resolveWorkspace?: (id: string) => WorkspaceIdentity | undefined): Promise<{ rows: ConsumptionRow[]; message: string | null }> {
  const paths = new Set<string>(); let warnings = 0, readable = 0;
  for (const root of roots) {
    if (signal.aborted) throw new Error('读取已取消');
    try {
      const nested = join(root, 'conversations');
      const dir = await stat(nested).then(() => nested, error => { if (error.code !== 'ENOENT') throw error; return root; });
      for (const item of await readdir(dir, { withFileTypes: true })) if (item.isFile() && item.name.endsWith('.db')) paths.add(await realpath(join(dir, item.name)));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings++; }
  }
  const events: AgyEvent[] = [];
  for (const path of paths) {
    if (signal.aborted) throw new Error('读取已取消');
    try {
      const result = readDatabase(path), workspace = resolveWorkspace?.(basename(path, '.db'));
      events.push(...result.events.map(event => workspace ? { ...event, workspace } : event)); warnings += result.warnings; readable++;
    } catch { warnings++; }
    // Let the plugin answer RPCs and cancellation between databases.
    await setImmediate();
  }
  if ((paths.size && !readable) || (!paths.size && warnings)) throw new Error('Antigravity 数据库无法读取，请检查读取权限或稍后重试');
  const rows = new Map<string, ConsumptionRow>(); let estimatedDates = 0, missingDates = 0;
  for (const event of dedupeAgy(events)) {
    if (event.time === undefined) { missingDates++; continue; }
    const date = dateInZone(new Date(event.time), range.timezone);
    if (date < range.since || date > range.until) continue;
    if (event.timeRank < 2) estimatedDates++;
    const key = JSON.stringify([date, event.model, event.workspace?.id]);
    let row = rows.get(key);
    if (!row) { row = { ...emptyTokens(), date, model: event.model, inferredModel: event.model === '未记录模型' || /^antigravity-model-/.test(event.model), ...(event.workspace ? { workspace: event.workspace } : {}) }; rows.set(key, row); }
    addTokens(row, { input: event.fresh + event.cacheRead + event.cacheWrite, output: event.output, cacheRead: event.cacheRead, cacheWrite: event.cacheWrite, reasoning: event.reasoning });
  }
  const messages = [warnings ? `${warnings} 个文件或记录未能读取` : '', missingDates ? `${missingDates} 条记录缺少日期，未计入` : '', estimatedDates ? `${estimatedDates} 条记录按会话日期归类` : ''].filter(Boolean);
  return { rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)), message: messages.length ? messages.join('；') : null };
}
