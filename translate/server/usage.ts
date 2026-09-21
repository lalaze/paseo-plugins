import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TranslationUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number | null };
export type TranslationUsageRecord = { v: 1; at: string; model: string; endpoint: 'primary' | 'fallback'; usage: TranslationUsage | null };

/** Ledger read by paseo-usage-glance; both plugins resolve the same directory. */
export function translationUsageRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.PASEO_TRANSLATE_USAGE_DIR?.trim();
  return configured || join(env.PASEO_HOME || join(home, '.paseo'), 'translate', 'usage');
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** OpenAI Chat Completions usage; prompt_tokens already includes cached tokens. Gateways that omit usage yield null. */
export function parseUsage(payload: unknown): TranslationUsage | null {
  const usage = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).usage : undefined;
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  const input = count(record.prompt_tokens ?? record.input_tokens), output = count(record.completion_tokens ?? record.output_tokens);
  if (input === null || output === null || !Number.isSafeInteger(input + output)) return null;
  const promptDetails = record.prompt_tokens_details as Record<string, unknown> | undefined;
  const completionDetails = record.completion_tokens_details as Record<string, unknown> | undefined;
  const cacheRead = Math.min(count(promptDetails?.cached_tokens) ?? 0, input);
  const reasoning = count(completionDetails?.reasoning_tokens);
  return { input, output, cacheRead, cacheWrite: 0, reasoning: reasoning !== null && reasoning <= output ? reasoning : null };
}

export type UsageLedger = { record(entry: Omit<TranslationUsageRecord, 'v'>): Promise<void> };

/** Append-only monthly JSONL files. Writes are serialized and failures never surface to the translation. */
export function createUsageLedger(root = translationUsageRoot()): UsageLedger {
  let queue = Promise.resolve();
  return {
    record(entry) {
      queue = queue.then(async () => {
        await mkdir(root, { recursive: true });
        await appendFile(join(root, `${entry.at.slice(0, 7)}.jsonl`), `${JSON.stringify({ v: 1, ...entry } satisfies TranslationUsageRecord)}\n`, { encoding: 'utf8', mode: 0o600 });
      }).catch(() => {});
      return queue;
    },
  };
}
