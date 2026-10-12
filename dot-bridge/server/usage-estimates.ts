import type { Task } from '../shared/schema';

export const USAGE_ESTIMATE_VERSION = 1 as const;
export const USAGE_ESTIMATE_ALGORITHM = 'visible-text-v1' as const;

export interface UsageEstimateEntry {
  id: string;
  at: number;
  taskId: string;
  workspaceId: string;
  cwd: string | null;
  input: number;
  output: number;
}

export interface UsageEstimateLedger {
  version: typeof USAGE_ESTIMATE_VERSION;
  algorithm: typeof USAGE_ESTIMATE_ALGORITHM;
  entries: UsageEstimateEntry[];
}

/**
 * A versioned trend heuristic, NOT model usage: ceil(ASCII code points / 4 + non-ASCII
 * code points). Unicode is counted by code point, not UTF-16 code unit. No tokenizer,
 * hidden reasoning, repeated context, tools, images or attachment bodies are included.
 */
export function estimateVisibleText(text: string): number {
  let quarters = 0;
  for (const character of text) quarters += character.codePointAt(0)! <= 0x7f ? 1 : 4;
  return Math.ceil(quarters / 4);
}

/** Rebuild from authoritative history; replaying/reopening never adds cumulative counters. */
export function buildUsageEstimateLedger(tasks: readonly Task[]): UsageEstimateLedger {
  const entries = new Map<string, UsageEstimateEntry>();
  for (const task of tasks) {
    const toolUpdates = new Set(task.localChanges.map(receipt => receipt.operationId));
    const add = (identity: string[], at: number, text: string, input: boolean) => {
      const id = JSON.stringify([task.id, ...identity]);
      const tokens = estimateVisibleText(text);
      // An edited-to-empty record must replace its previous estimate, not keep it alive.
      entries.set(id, {
        id, at, taskId: task.id, workspaceId: task.workspaceId,
        cwd: task.provider?.cwd ?? task.workspaceRoot ?? null,
        input: input ? tokens : 0, output: input ? 0 : tokens,
      });
    };
    for (const message of task.messages) {
      if (message.author === 'user') {
        // A user updateId acknowledges delivery; it is not the user's message identity.
        add(['user', String(message.seq)], message.at, message.body, true);
      } else if (['progress', 'question', 'result', 'error'].includes(message.kind)
        && !(message.updateId && toolUpdates.has(message.updateId))) {
        add(message.updateId
          ? ['dot', message.roundId, message.updateId]
          : ['dot-message', String(message.seq)], message.at, message.body, false);
      }
    }
    for (const round of task.rounds) {
      // Messages already contain progress/question notes. Never count progressHistory again.
      // Historical snapshots come first so the current revision of a stable ID wins.
      for (const result of [...round.resultHistory.map(item => item.result), ...(round.result ? [round.result] : [])]) {
        add(['dot', round.roundId, result.updateId], result.reportedAt, result.summary, false);
      }
    }
  }
  return {
    version: USAGE_ESTIMATE_VERSION,
    algorithm: USAGE_ESTIMATE_ALGORITHM,
    entries: [...entries.values()].filter(entry => entry.input + entry.output > 0)
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
  };
}
