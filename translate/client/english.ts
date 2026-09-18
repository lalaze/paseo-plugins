const letter = /\p{L}/u;
const latinLetter = /\p{Script=Latin}/u;

/**
 * Fast local guard for English-mode drafts. It allows Latin letters plus
 * language-neutral content such as code, URLs, numbers, punctuation and emoji.
 */
export function isEnglishCompatibleDraft(text: string): boolean {
  return [...text].every(character => !letter.test(character) || latinLetter.test(character));
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
