import type { ComponentType } from 'react';
import type { PluginClientContext, PluginTimelineItemProps, PluginTimelineTransformerContribution } from '@getpaseo/plugin/client';
import { z } from 'zod';
import { MAX_SOURCE_LENGTH } from '../shared/rpc';

export const replyTranslationSchema = z.object({ text: z.string() });
export type ReplyTranslationProps = PluginTimelineItemProps<z.infer<typeof replyTranslationSchema>>;

// The companion app patch advertises this capability. Old clients treat all
// transformers as replacements, so registering without the check would hide replies.
type ReplyClient = Pick<PluginClientContext, 'addTimelineRenderer'> & {
  supportsTimelineAfter?: boolean;
  addTimelineTransformer(contribution: PluginTimelineTransformerContribution<'assistant_message'> & { placement: 'after' }): () => void;
};

export function installReplyTranslations(client: ReplyClient, Component: ComponentType<ReplyTranslationProps>) {
  if (client.supportsTimelineAfter !== true) return () => {};
  const removeRenderer = client.addTimelineRenderer({ kind: 'reply-translation', version: 1, schema: replyTranslationSchema, Component });
  const removeTransformer = client.addTimelineTransformer({
    id: 'reply-translation',
    placement: 'after',
    query: { itemType: 'assistant_message' },
    transform: ({ item, phase }) => {
      if (phase !== 'complete' || !item.text.trim()) return;
      return { items: [{ type: 'plugin', kind: 'reply-translation', version: 1, data: { text: item.text } }] };
    },
  });
  return () => { removeTransformer(); removeRenderer(); };
}

/** Keep every character while preferring paragraph boundaries for long replies. */
export function splitReply(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_SOURCE_LENGTH) {
    const newline = rest.lastIndexOf('\n', MAX_SOURCE_LENGTH - 1);
    let end = newline >= MAX_SOURCE_LENGTH / 2 ? newline + 1 : MAX_SOURCE_LENGTH;
    // Never split a UTF-16 surrogate pair (e.g. an emoji) between API calls.
    const last = rest.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
