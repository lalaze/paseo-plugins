/** Longest title taken from a prompt, in characters (the schema allows 200). */
const MAX = 60;

/** The typed title, or else the prompt's first non-empty line, shortened with an ellipsis. */
export function taskTitle(title: string, prompt: string): string {
  const typed = title.trim();
  if (typed) return typed;
  const line = prompt.split('\n').map(item => item.trim()).find(Boolean) ?? '';
  const chars = [...line];
  return chars.length > MAX ? `${chars.slice(0, MAX - 1).join('')}…` : line;
}
