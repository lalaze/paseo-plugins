const letter = /\p{L}/u;
const latinLetter = /\p{Script=Latin}/u;
/** Code, quoted literals and titles are written verbatim, e.g. `验收通过`, "后台/调度", 《三体》. */
const verbatimSegment = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|《[^》\n]*》/g;
const latinWord = /\p{Script=Latin}+(?:['’]\p{Script=Latin}+)*/gu;
const foreignRun = /(?:(?!\p{Script=Latin})\p{L})(?:(?!\p{Script=Latin})\p{L}|\p{M})*/gu;
const unspacedScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Longest unquoted non-Latin run still read as a name or term; about eight Han characters. */
const MAX_FOREIGN_RUN_WORDS = 4;

/** Han and kana have no word spacing, so two characters approximate one word. */
function foreignRunWords(run: string): number {
  return unspacedScript.test(run) ? Math.ceil([...run].length / 2) : 1;
}

/**
 * Fast local guard for English-mode drafts. It allows Latin letters plus
 * language-neutral content such as code, URLs, numbers, punctuation and emoji.
 * English drafts may also carry verbatim quoted or coded text, and a few short
 * unquoted names or terms as long as English words clearly dominate.
 */
export function isEnglishCompatibleDraft(text: string): boolean {
  if ([...text].every(character => !letter.test(character) || latinLetter.test(character))) return true;
  const prose = text.replace(verbatimSegment, ' ');
  const latinWords = prose.match(latinWord)?.length ?? 0;
  if (!latinWords) return false;
  let foreignWords = 0;
  for (const [run] of prose.matchAll(foreignRun)) {
    const words = foreignRunWords(run);
    if (words > MAX_FOREIGN_RUN_WORDS) return false;
    foreignWords += words;
  }
  return foreignWords <= 1 || foreignWords * 2 <= latinWords;
}

/** Comma, semicolon or newline separated, case-insensitive model keywords. */
export function parseEnglishLockModels(value: string): string[] {
  return [...new Set(value.split(/[,，;；\n]+/).map(keyword => keyword.trim().toLocaleLowerCase()).filter(Boolean))];
}

export function matchesEnglishLockModel(descriptor: string | null, keywords: readonly string[]): boolean {
  if (!descriptor || !keywords.length) return false;
  const normalized = descriptor.toLocaleLowerCase();
  return keywords.some(keyword => normalized.includes(keyword));
}

/** Add the provider family hidden behind Paseo's short Claude model labels. */
export function normalizeComposerModelLabel(label: string): string | null {
  const normalized = label.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return /\b(?:opus|sonnet|haiku|fable|mythos)\b/i.test(normalized) ? `claude/${normalized}` : normalized;
}
