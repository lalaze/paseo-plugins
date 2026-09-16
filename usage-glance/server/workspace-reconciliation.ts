import { addTokens, emptyTokens, formatTokens, totalTokens, type ConsumptionRow, type Tokens, type WorkspaceConsumptionRow, type WorkspaceIssue } from '../shared/consumption';

const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;
const tokenLabels = { input: '输入', output: '输出', cacheRead: '缓存读取', cacheWrite: '缓存写入', reasoning: '推理' };
const equalTokens = (a?: Tokens, b?: Tokens) => !!a && !!b && tokenKeys.every(key => a[key] === b[key]);
function modelTotals(rows: WorkspaceConsumptionRow[]) {
  const totals = new Map<string, WorkspaceConsumptionRow>();
  for (const row of rows) {
    let total = totals.get(row.model);
    if (!total) { total = { ...emptyTokens(), model: row.model, inferredModel: false }; totals.set(row.model, total); }
    addTokens(total, row); total.inferredModel ||= row.inferredModel;
  }
  return totals;
}
export function workspaceTotalsMatch(rows: ConsumptionRow[], candidates: WorkspaceConsumptionRow[]): boolean {
  const daily = modelTotals(rows), sessions = modelTotals(candidates);
  return daily.size === sessions.size && [...daily].every(([model, total]) => equalTokens(total, sessions.get(model)));
}
function differenceNote(daily: Tokens, sessions: Tokens) {
  const count = (value: number | null) => value === null ? '未提供' : formatTokens(value);
  const differences = tokenKeys.filter(key => daily[key] !== sessions[key]).map(key => `${tokenLabels[key]} ${count(sessions[key])} / ${count(daily[key])}`);
  return `会话明细 ${formatTokens(totalTokens(sessions))} token；每日合计 ${formatTokens(totalTokens(daily))} token。差异项（明细 / 每日）：${differences.join('；')}。`;
}
/** Never guess allocations or redistribute a discrepancy proportionally across workspaces. */
export function reconcileWorkspaceRows(rows: ConsumptionRow[], candidates: WorkspaceConsumptionRow[], issue: WorkspaceIssue | ((model: string) => WorkspaceIssue) = 'accounting-mismatch'): WorkspaceConsumptionRow[] {
  const daily = modelTotals(rows), sessions = modelTotals(candidates);
  const groups = new Map<string, WorkspaceConsumptionRow[]>();
  for (const row of candidates) { const group = groups.get(row.model) ?? []; group.push(row); groups.set(row.model, group); }
  return [...daily.values()].flatMap(total => {
    const sum = sessions.get(total.model);
    if (sum && equalTokens(sum, total)) return groups.get(total.model)!;
    const reason = typeof issue === 'function' ? issue(total.model) : issue;
    return [{ ...total, workspaceIssue: reason, ...(reason === 'read-error' ? {} : { workspaceNote: differenceNote(total, sum ?? emptyTokens()) }) }];
  });
}

type DailyReading = { rows: ConsumptionRow[]; message: string | null };
type WorkspaceReading = { rows: WorkspaceConsumptionRow[]; message: string | null };
/** Retry only on disagreement: at most two daily reads and two detail reads per scan. */
export async function readReconciledWorkspace(readDaily: () => Promise<DailyReading>, readDetails: (daily: ConsumptionRow[]) => Promise<WorkspaceReading>, signal: AbortSignal) {
  let daily = await readDaily();
  if (!daily.rows.length) return { ...daily, workspaceRows: [] };
  let details: WorkspaceReading = { rows: [], message: null };
  let issue: WorkspaceIssue | ((model: string) => WorkspaceIssue) = 'accounting-mismatch';
  try {
    details = await readDetails(daily.rows);
    if (!workspaceTotalsMatch(daily.rows, details.rows)) {
      const before = modelTotals(daily.rows);
      daily = await readDaily();
      const after = modelTotals(daily.rows);
      const changed = new Set([...before.keys(), ...after.keys()].filter(model => !equalTokens(before.get(model), after.get(model))));
      if (changed.size && !workspaceTotalsMatch(daily.rows, details.rows)) details = await readDetails(daily.rows);
      issue = model => changed.has(model) ? 'updating' : 'accounting-mismatch';
    }
  } catch {
    if (signal.aborted) throw new Error('读取已取消');
    issue = 'read-error';
  }
  if (signal.aborted) throw new Error('读取已取消');
  const workspaceRows = reconcileWorkspaceRows(daily.rows, details.rows, issue);
  const unresolved = workspaceRows.some(row => row.workspaceIssue && row.workspaceIssue !== 'unmatched');
  // Flag extra session-only models even if the daily snapshot has no such row.
  const mismatch = !workspaceTotalsMatch(daily.rows, details.rows);
  return { ...daily, workspaceRows, message: [daily.message, details.message, unresolved || mismatch ? '部分用量尚未完成 Workspace 归属，已保留每日总量，请查看分类说明或稍后刷新。' : null].filter(Boolean).join('；') || null };
}
