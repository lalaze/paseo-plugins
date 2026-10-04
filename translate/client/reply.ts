type TimelineItem = { type: string; text?: unknown };
export type LatestReply = { text: string; truncated: boolean };

/** Returns the full newest reply; callers can explicitly request a clipped preview. */
export function latestAssistantText(items: readonly TimelineItem[], limit = Infinity): LatestReply | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.type !== 'assistant_message' || typeof item.text !== 'string') continue;
    const text = item.text.trim();
    if (!text) continue;
    if (text.length <= limit) return { text, truncated: false };
    const cut = text.lastIndexOf('\n', limit);
    return { text: text.slice(0, cut > limit / 2 ? cut : limit).trimEnd(), truncated: true };
  }
  return null;
}
