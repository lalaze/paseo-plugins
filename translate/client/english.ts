const letter = /\p{L}/u;
const latinLetter = /\p{Script=Latin}/u;

/**
 * Fast local guard for English-mode drafts. It allows Latin letters plus
 * language-neutral content such as code, URLs, numbers, punctuation and emoji.
 */
export function isEnglishCompatibleDraft(text: string): boolean {
  return [...text].every(character => !letter.test(character) || latinLetter.test(character));
}
