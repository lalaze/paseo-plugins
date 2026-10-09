import { ui } from './i18n';

/** Matches paseo-translate's per-call source limit. */
export const TASK_TRANSLATION_LIMIT = 5000;

export type PromptUndo = { before: string; after: string };

export type PromptTranslateClick =
  | { kind: 'undo'; prompt: string }
  | { kind: 'translate'; text: string; original: string }
  | { kind: 'reject'; message: string };

/** One click of the task prompt's translate button. A second click on an unchanged translation undoes it. */
export function promptTranslateClick(input: { prompt: string; undo: PromptUndo | null; busy: boolean }): PromptTranslateClick | null {
  if (input.busy) return null;
  if (input.undo && input.prompt === input.undo.after) return { kind: 'undo', prompt: input.undo.before };
  const text = input.prompt.trim();
  if (!text) return { kind: 'reject', message: ui('Write the task before translating it', '请先写下任务内容再翻译') };
  if (text.length > TASK_TRANSLATION_LIMIT) return { kind: 'reject', message: ui('A task translation cannot be longer than 5,000 characters', '任务内容超过 5000 字，无法翻译') };
  return { kind: 'translate', text, original: input.prompt };
}

/** Drop a late translation when the task text changed while it was running. */
export function promptAfterTranslation(current: string, original: string, translation: string): { prompt: string; undo: PromptUndo } | null {
  if (current !== original) return null;
  return { prompt: translation, undo: { before: original, after: translation } };
}
