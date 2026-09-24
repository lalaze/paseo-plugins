import assert from 'node:assert/strict';
import test from 'node:test';
import { latestAssistantText } from '../client/reply';
import { installReplyTranslations, splitReply } from '../client/reply-translation';
import { MAX_SOURCE_LENGTH } from '../shared/rpc';

test('picks the newest non-empty assistant message and skips other items', () => {
  const items = [
    { type: 'assistant_message', text: 'first' },
    { type: 'user_message', text: 'question' },
    { type: 'assistant_message', text: ' second ' },
    { type: 'tool_call', name: 'read' },
    { type: 'assistant_message', text: '   ' },
    { type: 'reasoning', text: 'thinking' },
  ];
  assert.deepEqual(latestAssistantText(items), { text: 'second', truncated: false });
  assert.equal(latestAssistantText([{ type: 'user_message', text: 'hi' }]), null);
  assert.equal(latestAssistantText([]), null);
});

test('long reply chunks preserve all text, paragraph boundaries and emoji', () => {
  const sources = [
    'short reply',
    'a'.repeat(MAX_SOURCE_LENGTH),
    `${'a'.repeat(MAX_SOURCE_LENGTH - 1)}😀${'b'.repeat(MAX_SOURCE_LENGTH + 20)}`,
    `${'first paragraph '.repeat(220)}\n\n${'second paragraph '.repeat(700)}`,
  ];
  for (const source of sources) {
    const chunks = splitReply(source);
    assert.equal(chunks.join(''), source);
    assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= MAX_SOURCE_LENGTH));
    assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)));
  }
  assert.deepEqual(splitReply(''), []);
});

test('native reply controls require explicit app support and leave source rendering to the app', () => {
  type Client = Parameters<typeof installReplyTranslations>[0];
  const transformers: Parameters<Client['addTimelineTransformer']>[0][] = [];
  let renderers = 0;
  const client: Client = {
    addTimelineRenderer() { renderers++; return () => { renderers--; }; },
    addTimelineTransformer(contribution) { transformers.push(contribution); return () => { transformers.splice(transformers.indexOf(contribution), 1); }; },
  };
  installReplyTranslations(client, () => null)();
  assert.equal(renderers, 0);
  assert.equal(transformers.length, 0);
  const dispose = installReplyTranslations({ ...client, supportsTimelineAfter: true }, () => null);
  const contribution = transformers[0];
  assert.equal(renderers, 1);
  assert.equal(contribution.placement, 'after');
  assert.equal(contribution.query.itemType, 'assistant_message');
  assert.equal(contribution.transform({ item: { type: 'assistant_message', text: 'hello' }, phase: 'streaming' }), undefined);
  assert.equal(contribution.transform({ item: { type: 'assistant_message', text: ' ' }, phase: 'complete' }), undefined);
  const text = 'long reply '.repeat(1000);
  assert.deepEqual(contribution.transform({ item: { type: 'assistant_message', text }, phase: 'complete' }), {
    items: [{ type: 'plugin', kind: 'reply-translation', version: 1, data: { text } }],
  });
  dispose();
  assert.equal(renderers, 0);
  assert.equal(transformers.length, 0);
});

test('clips long replies at a nearby line break, otherwise at the limit', () => {
  const paragraph = 'a'.repeat(60);
  const clipped = latestAssistantText([{ type: 'assistant_message', text: `${paragraph}\n${paragraph}\n${paragraph}` }], 150);
  assert.deepEqual(clipped, { text: `${paragraph}\n${paragraph}`, truncated: true });
  const solid = latestAssistantText([{ type: 'assistant_message', text: 'b'.repeat(200) }], 150);
  assert.deepEqual(solid, { text: 'b'.repeat(150), truncated: true });
  const earlyBreak = latestAssistantText([{ type: 'assistant_message', text: `ab\n${'c'.repeat(200)}` }], 150);
  assert.deepEqual(earlyBreak, { text: `ab\n${'c'.repeat(147)}`, truncated: true });
});
